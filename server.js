const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mimeTypes = require('mime-types');
require('dotenv').config();

const { settingsStore, folderStore, fileStore, userConfigStore, userStore } = require('./db');
const auth = require('./auth');
const tg = require('./telegram');
const mtprotoLib = require('./mtproto');
const { Readable } = require('stream');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 临时文件存储
const tmpDir = path.join(os.tmpdir(), 'tg-cloud-drive-uploads');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

// 文件缓存（仅用于加速重复访问，可随时删除，程序会从 Telegram 重新拉取）
const cacheDir = path.join(os.tmpdir(), 'tg-cloud-drive-cache');
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

// 缓存上限（防止在磁盘较小的 VPS 上把磁盘写满）
// 单文件上限放宽到 800MB：让常见的大视频也能落本地缓存，从而从磁盘带 Range 稳定拖动播放
// （之前 50MB 门槛导致 >50MB 视频只能走 TG 实时代理，链路长易卡死）
const MAX_CACHE_FILE_SIZE = 800 * 1024 * 1024;
// 缓存目录总占用上限 400MB：1.2G 盘目前约 700MB 空闲，留足余量；LRU 按修改时间自动清理
const MAX_CACHE_TOTAL_SIZE = 400 * 1024 * 1024;

// 超过总占用上限时，按修改时间从旧到新删除，直到低于上限
function enforceCacheLimit() {
  try {
    const files = fs.readdirSync(cacheDir).map(name => {
      const p = path.join(cacheDir, name);
      let st;
      try { st = fs.statSync(p); } catch { return null; }
      return { p, mtime: st.mtimeMs, size: st.size };
    }).filter(Boolean);
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= MAX_CACHE_TOTAL_SIZE) return;
    files.sort((a, b) => a.mtime - b.mtime); // 最旧的优先删除
    for (const f of files) {
      if (total <= MAX_CACHE_TOTAL_SIZE) break;
      try {
        fs.unlinkSync(f.p);
        total -= f.size;
        console.log(`[cache] evicted ${path.basename(f.p)} (total now ${(total/1024/1024).toFixed(1)}MB)`);
      } catch {}
    }
  } catch (err) {
    console.warn('[cache] enforceCacheLimit failed:', err.message);
  }
}

// 把 Bot 文件完整下载到本地缓存（去重：同一文件并发只下载一次）。
// 独立于客户端响应流，保证即使本次实时代理不稳定，文件也能落盘，下次从本地稳定播放。
const cacheLocks = new Map();
function cacheBotFile(bot, fileId, cacheFile, fileSize) {
  try {
    if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size === fileSize) return Promise.resolve();
  } catch {}
  if (cacheLocks.has(cacheFile)) return cacheLocks.get(cacheFile);
  const p = (async () => {
    const link = await bot.getFileLink(fileId);
    const fileUrl = (link && link.href) ? link.href : String(link);
    const axiosConfig = { method: 'GET', url: fileUrl, responseType: 'stream', timeout: 1800000 };
    if (bot.proxyAgent) { axiosConfig.httpsAgent = bot.proxyAgent; axiosConfig.proxy = false; }
    const resp = await axios(axiosConfig);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(cacheFile);
      resp.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      resp.data.on('error', reject);
    });
  })().catch((e) => {
    console.error('[cache] bot 文件缓存失败:', e.message);
    try { fs.unlinkSync(cacheFile); } catch {}
  }).finally(() => { cacheLocks.delete(cacheFile); });
  cacheLocks.set(cacheFile, p);
  return p;
}

// 清理上传残留（进程崩溃可能留下没删的大文件）：超过 1 小时的临时文件视为残留删除
function cleanStaleUploads() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(tmpDir)) {
      const p = path.join(tmpDir, name);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (now - st.mtimeMs > 60 * 60 * 1000) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  } catch {}
}

// 启动时及每小时执行清理，避免缓存/临时文件无限增长把磁盘写满
enforceCacheLimit();
cleanStaleUploads();
setInterval(() => { enforceCacheLimit(); cleanStaleUploads(); }, 60 * 60 * 1000);

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: 2000 * 1024 * 1024 } // 2GB（本地 Bot API Server 支持）
});

// 兼容不同前端/客户端发出的请求体：
// 1) application/json（标准）
// 2) text/plain（部分旧版前端 fetch 默认不带 Content-Type 时发送）
// 3) application/x-www-form-urlencoded（兜底）
app.use(express.json({ type: ['application/json', 'text/plain'], limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  // HTML 不缓存，保证版本号更新后立即生效；CSS/JS 由 ?v= 版本号控制
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ============ 每用户实例缓存 ============
// 每位登录用户持有独立的 bot 控制器与 MTProto 控制器
const botInstances = new Map();      // userId -> bot controller
const mtprotoInstances = new Map();  // userId -> mtproto controller

function getUserConfig(userId) {
  return userConfigStore.get(userId);
}

function getBotForUser(userId) {
  if (botInstances.has(userId)) return botInstances.get(userId);
  const cfg = getUserConfig(userId);
  if (!cfg || !cfg.bot_token) return null;
  const controller = tg.createBotController(cfg.bot_token, {
    proxy: cfg.proxy || '',
    api_root: cfg.api_root || ''
  });
  botInstances.set(userId, controller);
  return controller;
}

function getMtprotoForUser(userId) {
  if (mtprotoInstances.has(userId)) return mtprotoInstances.get(userId);
  const cfg = getUserConfig(userId);
  if (!cfg || !cfg.mtproto_api_id || !cfg.mtproto_api_hash) return null;
  const controller = mtprotoLib.createMtprotoController({
    apiId: cfg.mtproto_api_id,
    apiHash: cfg.mtproto_api_hash,
    session: cfg.mtproto_session || '',
    proxy: cfg.proxy || '',
    channelId: cfg.channel_id || '',
    persistSession: (sessionStr) => {
      try { userConfigStore.setKey(userId, 'mtproto_session', sessionStr); } catch (e) {
        console.warn('[mtproto] persistSession failed:', e.message);
      }
    }
  });
  mtprotoInstances.set(userId, controller);
  return controller;
}

// 用户更新配置后，使缓存的实例失效，下次请求会使用新配置重建
function invalidateUserInstances(userId) {
  botInstances.delete(userId);
  mtprotoInstances.delete(userId);
}

// 确保 MTProto 已连接（若未连接尝试恢复 session）
async function ensureMtprotoConnected(userId) {
  const ctrl = getMtprotoForUser(userId);
  if (!ctrl) return null;
  if (!ctrl.isConnected()) {
    const ok = await ctrl.restoreSession();
    if (!ok) return null;
  }
  return ctrl;
}

// ============ 认证 API ============
app.post('/api/auth/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: '用户名至少 3 个字符' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 个字符' });
  }
  if (userStore.getByUsername(username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }
  const user = userStore.create(username, password, false);
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({
    success: true,
    user: { id: user.id, username: user.username, is_admin: !!user.is_admin }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, admin } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  const user = userStore.verify(username, password);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({
    success: true,
    user: { id: user.id, username: user.username, is_admin: !!user.is_admin }
  });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = auth.parseCookies(req);
  if (cookies.tg_session) auth.destroySession(cookies.tg_session);
  // 清除 cookie
  res.clearCookie('tg_session', { path: '/' });
  res.json({ success: true });
});

app.get('/api/auth/me', auth.requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      is_admin: !!req.user.is_admin
    }
  });
});

// ============ 每用户 Telegram 配置 API ============
app.get('/api/user/config', auth.requireAuth, (req, res) => {
  const cfg = getUserConfig(req.user.id);
  res.json({
    configured: !!(cfg.bot_token && cfg.channel_id),
    bot_token_masked: cfg.bot_token ? cfg.bot_token.substring(0, 10) + '****' : '',
    channel_id: cfg.channel_id || '',
    bot_username: cfg.bot_username || '',
    proxy: cfg.proxy || '',
    api_root: cfg.api_root || '',
    mtproto_configured: !!(cfg.mtproto_api_id && cfg.mtproto_api_hash),
    mtproto_api_id: cfg.mtproto_api_id ? cfg.mtproto_api_id.substring(0, 4) + '****' : '',
    mtproto_api_hash: cfg.mtproto_api_hash ? cfg.mtproto_api_hash.substring(0, 8) + '****' : '',
    mtproto_logged_in: !!(cfg.mtproto_session && cfg.mtproto_session.length > 10)
  });
});

app.post('/api/user/config', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { bot_token, channel_id, force_save, proxy, api_root } = req.body;

  if (proxy !== undefined) userConfigStore.setKey(userId, 'proxy', proxy || '');
  if (api_root !== undefined) userConfigStore.setKey(userId, 'api_root', api_root || '');

  const cfg = getUserConfig(userId);

  if (bot_token) {
    if (force_save) {
      userConfigStore.setKey(userId, 'bot_token', bot_token);
    } else {
      // 用临时控制器验证 token
      const tempBot = tg.createBotController(bot_token, { proxy: cfg.proxy || '', api_root: cfg.api_root || '' });
      const validation = await tempBot.validateBot();
      if (!validation.valid) {
        return res.status(400).json({ error: `Bot Token 验证失败: ${validation.error}` });
      }
      userConfigStore.setKey(userId, 'bot_token', bot_token);
      userConfigStore.setKey(userId, 'bot_username', validation.info.username);
    }
  }

  if (channel_id) {
    const parsedId = parseInt(channel_id);
    if (!force_save && cfg.bot_token) {
      const tempBot = tg.createBotController(cfg.bot_token, { proxy: cfg.proxy || '', api_root: cfg.api_root || '' });
      const chValidation = await tempBot.validateChannel(parsedId);
      if (!chValidation.valid) {
        return res.status(400).json({ error: `频道验证失败: ${chValidation.error}` });
      }
    }
    userConfigStore.setKey(userId, 'channel_id', parsedId.toString());
  }

  // 配置变更，重建实例
  invalidateUserInstances(userId);
  res.json({ success: true, message: force_save ? '配置已保存（跳过验证）' : '配置已保存并验证通过' });
});

// ============ 文件列表 API（按用户隔离）============
app.get('/api/files', auth.requireAuth, (req, res) => {
  const folderId = req.query.folder_id ? parseInt(req.query.folder_id) : null;
  const files = fileStore.getByFolder(folderId, req.user.id);
  res.json(files);
});

app.get('/api/files/search', auth.requireAuth, (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json([]);
  const files = fileStore.search(q, req.user.id);
  res.json(files);
});

app.get('/api/files/:id', auth.requireAuth, (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id), req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  res.json(file);
});

// ============ 文件上传 API ============
app.post('/api/upload', auth.requireAuth, upload.array('files', 20), async (req, res) => {
  const userId = req.user.id;
  const bot = getBotForUser(userId);
  if (!bot) {
    return res.status(503).json({ error: '请先在「我的配置」中绑定 Bot Token 和频道 ID' });
  }
  const cfg = getUserConfig(userId);
  const channelId = cfg.channel_id ? parseInt(cfg.channel_id) : null;
  if (!channelId) {
    return res.status(503).json({ error: '请先在「我的配置」中设置频道 ID' });
  }
  const apiRoot = cfg.api_root || '';
  const isLocalApi = apiRoot && !apiRoot.includes('api.telegram.org');
  const folderId = req.body.folder_id ? parseInt(req.body.folder_id) : null;
  const results = [];
  const errors = [];

  for (const file of req.files) {
    try {
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

      if (!isLocalApi && file.size > 50 * 1024 * 1024) {
        errors.push({
          file: originalName,
          error: '文件超过 50MB（Telegram 云端 Bot API 限制）。如需上传大文件，请在配置中设置本地 Bot API Server 地址。'
        });
        try { fs.unlinkSync(file.path); } catch {}
        continue;
      }

      const tgResult = await bot.uploadFile(file, channelId);
      const record = fileStore.create({
        name: originalName,
        original_name: originalName,
        size: file.size,
        mime_type: file.mimetype,
        file_type: tgResult.file_type,
        file_id: tgResult.file_id,
        file_unique_id: tgResult.file_unique_id,
        thumb_file_id: tgResult.thumb_file_id,
        message_id: tgResult.message_id,
        folder_id: folderId,
        user_id: userId
      });
      results.push(record);
    } catch (err) {
      const displayName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      console.error('上传失败:', displayName, err.message);
      errors.push({ file: displayName, error: err.message });
    } finally {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }

  res.json({ success: results, errors });
});

// ============ 文件下载 API ============
app.get('/api/download/:id', auth.requireAuth, async (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id), req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const bot = getBotForUser(req.user.id);
  if (!bot) return res.status(503).json({ error: '未配置 Bot' });

  try {
    const stream = await bot.downloadFile(file.file_id);
    const encodedName = encodeURIComponent(file.name).replace(/'/g, '%27');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: `下载失败: ${err.message}` });
  }
});

// ============ 文件预览 API ============
// 优先从本地缓存服务：视频/大文件落本地后，浏览器可带 Range 拖动播放、稳定不卡。
// 未缓存时实时代理到 Telegram（立即给浏览器数据），并后台独立下载完整文件到本地缓存，
// 这样即使首次代理较慢，下次也能从本地磁盘稳定、可拖动地播放。
app.get('/api/preview/:id', auth.requireAuth, async (req, res) => {
  req.setTimeout(1800000);
  res.setTimeout(1800000);

  const file = fileStore.getById(parseInt(req.params.id), req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const bot = getBotForUser(req.user.id);
  if (!bot) return res.status(503).json({ error: '未配置 Bot' });

  try {
    const fileSize = file.size;
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `bot_u${req.user.id}_${file.id}`);
    const cacheExists = fs.existsSync(cacheFile) && fs.statSync(cacheFile).size === fileSize;

    // 本地缓存命中：从磁盘带 Range 高速、稳定、可拖动播放
    if (cacheExists) {
      const range = req.headers.range;
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Accel-Buffering', 'no');
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': chunkSize,
        });
        fs.createReadStream(cacheFile, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': fileSize });
        fs.createReadStream(cacheFile).pipe(res);
      }
      return;
    }

    // 未缓存：实时代理到 TG（立即给浏览器数据），并后台把完整文件缓存到本地
    const link = await bot.getFileLink(file.file_id);
    const fileUrl = (link && link.href) ? link.href : String(link);
    const range = req.headers.range;
    const axiosConfig = {
      method: 'GET',
      url: fileUrl,
      responseType: 'stream',
      timeout: 1800000,
    };
    if (range) axiosConfig.headers = { Range: range };
    if (bot.proxyAgent) {
      axiosConfig.httpsAgent = bot.proxyAgent;
      axiosConfig.proxy = false;
    }

    const response = await axios(axiosConfig);

    res.status(response.status); // 200 或 206
    res.setHeader('Content-Type', file.mime_type || response.headers['content-type'] || 'application/octet-stream');
    if (response.headers['content-range']) res.setHeader('Content-Range', response.headers['content-range']);
    if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
    res.setHeader('Accept-Ranges', response.headers['accept-ranges'] || 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Accel-Buffering', 'no');

    response.data.pipe(res);
    response.data.on('error', () => { if (!res.writableEnded) res.end(); });

    // 后台把完整文件缓存到本地（<=800MB 才缓存，避免写满小磁盘）；即使本次代理不稳，下次也能本地稳定播放
    if (fileSize <= MAX_CACHE_FILE_SIZE) {
      cacheBotFile(bot, file.file_id, cacheFile, fileSize);
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: `预览失败: ${err.message}` });
    else if (!res.writableEnded) res.end();
  }
});

// ============ 缩略图 API ============
app.get('/api/thumb/:id', auth.requireAuth, async (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id), req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!file.thumb_file_id) return res.status(404).json({ error: '无缩略图' });
  const bot = getBotForUser(req.user.id);
  if (!bot) return res.status(503).json({ error: '未配置 Bot' });

  try {
    const stream = await bot.downloadFile(file.thumb_file_id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: `缩略图获取失败: ${err.message}` });
  }
});

// ============ 文件操作 API ============
app.delete('/api/files/:id', auth.requireAuth, async (req, res) => {
  const userId = req.user.id;
  const file = fileStore.getById(parseInt(req.params.id), userId);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const cfg = getUserConfig(userId);
  const channelId = cfg.channel_id ? parseInt(cfg.channel_id) : null;
  const bot = getBotForUser(userId);

  try {
    if (bot && channelId) await bot.deleteMessage(channelId, file.message_id);
  } catch (err) {
    console.warn('删除 Telegram 消息失败:', err.message);
  }

  fileStore.delete(file.id);
  res.json({ success: true });
});

app.patch('/api/files/:id', auth.requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const { name, folder_id } = req.body;
  let file = fileStore.getById(id, req.user.id);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  if (name) file = fileStore.rename(id, name);
  if (folder_id !== undefined) file = fileStore.move(id, folder_id === 0 ? null : folder_id);

  res.json(file);
});

// ============ 文件夹 API（按用户隔离）============
app.get('/api/folders', auth.requireAuth, (req, res) => {
  const parentId = req.query.parent_id ? parseInt(req.query.parent_id) : null;
  const folders = folderStore.getByParent(parentId, req.user.id);
  res.json(folders);
});

app.get('/api/folders/path/:id', auth.requireAuth, (req, res) => {
  const id = req.params.id === '0' ? null : parseInt(req.params.id);
  const path = folderStore.getPath(id);
  res.json(path);
});

app.post('/api/folders', auth.requireAuth, (req, res) => {
  const { name, parent_id } = req.body;
  if (!name) return res.status(400).json({ error: '文件夹名称不能为空' });
  const folder = folderStore.create(name, parent_id ? parseInt(parent_id) : null, req.user.id);
  res.json(folder);
});

app.patch('/api/folders/:id', auth.requireAuth, (req, res) => {
  const { name } = req.body;
  const folder = folderStore.rename(parseInt(req.params.id), name);
  res.json(folder);
});

app.delete('/api/folders/:id', auth.requireAuth, (req, res) => {
  folderStore.delete(parseInt(req.params.id));
  res.json({ success: true });
});

// ============ 统计 API（按用户隔离）============
app.get('/api/stats', auth.requireAuth, (req, res) => {
  const userId = req.user.id;
  const fileCount = fileStore.count(userId);
  const totalSize = fileStore.totalSize(userId);
  const byType = fileStore.statsByType(userId);
  const recent = fileStore.recent(5, userId);

  res.json({
    file_count: fileCount,
    total_size: totalSize,
    by_type: byType,
    recent_files: recent
  });
});

// ============ 每用户 MTProto API ============

// MTProto 状态
app.get('/api/user/mtproto/status', auth.requireAuth, async (req, res) => {
  try {
    const cfg = getUserConfig(req.user.id);
    const hasApi = !!(cfg.mtproto_api_id && cfg.mtproto_api_hash);
    const hasSession = !!(cfg.mtproto_session && cfg.mtproto_session.length > 10);

    const ctrl = getMtprotoForUser(req.user.id);
    if (ctrl && ctrl.isConnected()) {
      const userInfo = await ctrl.getUserInfo();
      return res.json({
        connected: true,
        logged_in: !!userInfo,
        user: userInfo,
        has_api: hasApi,
        channel_id: cfg.channel_id || ''
      });
    }

    if (hasSession && hasApi) {
      const restored = await (ctrl ? ctrl.restoreSession() : false);
      if (restored) {
        const userInfo = await ctrl.getUserInfo();
        return res.json({
          connected: true,
          logged_in: !!userInfo,
          user: userInfo,
          has_api: true,
          channel_id: cfg.channel_id || ''
        });
      }
    }

    res.json({
      connected: false,
      logged_in: false,
      user: null,
      has_api: hasApi,
      channel_id: cfg.channel_id || ''
    });
  } catch (err) {
    res.json({
      connected: false,
      logged_in: false,
      user: null,
      has_api: false,
      error: err.message,
    });
  }
});

// 配置 API ID / API Hash
app.post('/api/user/mtproto/config', auth.requireAuth, (req, res) => {
  const { api_id, api_hash } = req.body;
  if (api_id) userConfigStore.setKey(req.user.id, 'mtproto_api_id', api_id.toString());
  if (api_hash) userConfigStore.setKey(req.user.id, 'mtproto_api_hash', api_hash);
  invalidateUserInstances(req.user.id);
  res.json({ success: true, message: 'API 配置已保存' });
});

// 发送验证码
app.post('/api/user/mtproto/send-code', auth.requireAuth, async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: '请输入手机号' });

  try {
    const ctrl = getMtprotoForUser(req.user.id);
    if (!ctrl) return res.status(400).json({ error: '请先在「我的配置」中填写 API ID 和 API Hash' });
    const result = await ctrl.sendCode(phone_number);
    res.json({ success: true, isRegistered: result.isRegistered });
  } catch (err) {
    res.status(400).json({ error: `发送验证码失败: ${err.message || err.errorMessage}` });
  }
});

// 验证验证码
app.post('/api/user/mtproto/verify-code', auth.requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  try {
    const ctrl = getMtprotoForUser(req.user.id);
    if (!ctrl) return res.status(400).json({ error: '请先发送验证码' });
    const result = await ctrl.verifyCode(code);
    if (result.success) {
      res.json({ success: true, user: result.user });
    } else if (result.needs2FA) {
      res.json({ success: false, needs2FA: true });
    } else {
      res.status(400).json({ error: '验证失败' });
    }
  } catch (err) {
    res.status(400).json({ error: `验证失败: ${err.message || err.errorMessage}` });
  }
});

// 两步验证
app.post('/api/user/mtproto/verify-2fa', auth.requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });

  try {
    const ctrl = getMtprotoForUser(req.user.id);
    if (!ctrl) return res.status(400).json({ error: '请先发送验证码' });
    const result = await ctrl.verify2FA(password);
    if (result.success) {
      res.json({ success: true, user: result.user });
    } else {
      res.status(400).json({ error: '验证失败' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message || err.errorMessage });
  }
});

// 登出
app.post('/api/user/mtproto/logout', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = getMtprotoForUser(req.user.id);
    if (ctrl) await ctrl.logout();
    invalidateUserInstances(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 频道文件列表
app.get('/api/user/mtproto/channel/files', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const result = await ctrl.getChannelFiles(offset, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道搜索
app.get('/api/user/mtproto/channel/search', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const q = req.query.q || '';
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const result = await ctrl.searchChannelFiles(q, offset);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件下载
app.get('/api/user/mtproto/channel/download/:messageId', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    const stream = await ctrl.downloadChannelFileStream(messageId);
    const mimeType = req.query.mime || 'application/octet-stream';
    const fileName = req.query.name || `file_${messageId}`;
    const encodedName = encodeURIComponent(fileName).replace(/'/g, '%27');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件预览
app.get('/api/user/mtproto/channel/preview/:messageId', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    const stream = await ctrl.downloadChannelFileStream(messageId);
    const mimeType = req.query.mime || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件缩略图
app.get('/api/user/mtproto/channel/thumb/:messageId', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    const buffer = await ctrl.downloadChannelThumb(messageId);
    if (buffer) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(buffer);
    } else {
      res.status(404).json({ error: '无缩略图' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件流式播放（支持 Range 请求，用于视频/音频播放）
app.get('/api/user/mtproto/channel/stream/:messageId', auth.requireAuth, async (req, res) => {
  req.setTimeout(1800000);
  res.setTimeout(1800000);

  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    const mimeType = req.query.mime || 'application/octet-stream';

    const fileInfo = await ctrl.getChannelMessageInfo(messageId);
    const fileSize = fileInfo.size;

    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `u${req.user.id}_msg_${messageId}`);

    const cacheExists = fs.existsSync(cacheFile) && fs.statSync(cacheFile).size === fileSize;

    if (cacheExists) {
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=3600',
          'X-Accel-Buffering': 'no',
        });
        fs.createReadStream(cacheFile, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          'X-Accel-Buffering': 'no',
        });
        fs.createReadStream(cacheFile).pipe(res);
      }
      return;
    }

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
        'X-Accel-Buffering': 'no',
      });

      await ctrl.streamChannelFileToResponse(messageId, res, start, chunkSize);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'X-Accel-Buffering': 'no',
      });

      await ctrl.streamChannelFileToResponse(messageId, res, 0, 0);
    }

    // 后台异步缓存完整文件（大文件 >50MB 不缓存，避免把小磁盘 VPS 写满）
    if (!fs.existsSync(cacheFile) && fileSize <= MAX_CACHE_FILE_SIZE) {
      ctrl.downloadChannelFileToPath(messageId, cacheFile).then(() => {
        enforceCacheLimit();
      }).catch(err => {
        console.warn(`[cache] Background cache failed for msg ${messageId}:`, err.message);
      });
    }
  } catch (err) {
    console.error('Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

// 频道文件删除
app.delete('/api/user/mtproto/channel/files/:messageId', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    await ctrl.deleteChannelMessage(messageId);

    const cacheFile = path.join(cacheDir, `u${req.user.id}_msg_${messageId}`);
    try { fs.unlinkSync(cacheFile); } catch {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件重命名（编辑消息文案）
app.patch('/api/user/mtproto/channel/files/:messageId', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const messageId = parseInt(req.params.messageId);
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    await ctrl.editChannelMessageCaption(messageId, name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件转发（复制/剪切粘贴）
app.post('/api/user/mtproto/channel/forward', auth.requireAuth, async (req, res) => {
  try {
    const ctrl = await ensureMtprotoConnected(req.user.id);
    if (!ctrl) return res.status(403).json({ error: 'MTProto 未登录' });
    const { message_ids, delete_original } = req.body;
    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json({ error: '请选择要粘贴的文件' });
    }

    await ctrl.forwardMessagesToChannel(message_ids);

    if (delete_original) {
      for (const msgId of message_ids) {
        try {
          await ctrl.deleteChannelMessage(msgId);
          const cacheFile = path.join(cacheDir, `u${req.user.id}_msg_${msgId}`);
          try { fs.unlinkSync(cacheFile); } catch {}
        } catch (err) {
          console.warn('删除原消息失败:', msgId, err.message);
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bot API 文件复制
app.post('/api/files/copy', auth.requireAuth, (req, res) => {
  const { ids, folder_id } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要复制的文件' });
  }
  const targetFolder = folder_id === 0 ? null : folder_id;
  const results = [];
  for (const id of ids) {
    const file = fileStore.copy(parseInt(id), targetFolder, req.user.id);
    if (file) results.push(file);
  }
  res.json({ success: true, count: results.length });
});

// Bot API 文件剪切（移动）
app.post('/api/files/move', auth.requireAuth, (req, res) => {
  const { ids, folder_id } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要移动的文件' });
  }
  const targetFolder = folder_id === 0 ? null : folder_id;
  for (const id of ids) {
    fileStore.move(parseInt(id), targetFolder);
  }
  res.json({ success: true, count: ids.length });
});

// ============ 管理员：用户管理 API ============
app.get('/api/admin/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const db = require('./db').db;
  const rows = db.prepare('SELECT id, username, is_admin, created_at FROM users ORDER BY id').all();
  res.json(rows);
});

app.delete('/api/admin/users/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }
  const db = require('./db').db;
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    invalidateUserInstances(targetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 开机自启动 API（仅管理员，Windows 专用）============
const { execSync } = require('child_process');
const START_BAT_PATH = path.join(__dirname, 'start.bat');
const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_REG_NAME = 'TelegramCloudDrive';
const PS_REG_KEY = AUTOSTART_REG_KEY.replace('HKCU\\', 'HKCU:\\').replace('HKLM\\', 'HKLM:\\');

function isAutostartEnabled() {
  try {
    const psCmd = `powershell -NoProfile -Command "$v = Get-ItemProperty -Path '${PS_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue; if ($v) { Write-Output 'EXISTS' } else { Write-Output 'NOTFOUND' }"`;
    const output = execSync(psCmd, { encoding: 'utf-8' });
    return output.includes('EXISTS');
  } catch {
    return false;
  }
}

function enableAutostart() {
  const vbsPath = path.join(__dirname, 'autostart.vbs');
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "cmd /c ""${START_BAT_PATH}""", 0, False\nSet WshShell = Nothing\n`;
  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
  const regValue = `wscript.exe "${vbsPath}"`;
  const escapedValue = regValue.replace(/'/g, "''");
  const psCmd = `powershell -NoProfile -Command "Set-ItemProperty -Path '${PS_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -Value '${escapedValue}' -Force"`;
  execSync(psCmd);
}

function disableAutostart() {
  try {
    const psCmd = `powershell -NoProfile -Command "Remove-ItemProperty -Path '${PS_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue"`;
    execSync(psCmd);
  } catch {}
  const vbsPath = path.join(__dirname, 'autostart.vbs');
  try { fs.unlinkSync(vbsPath); } catch {}
}

app.get('/api/autostart', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({ enabled: isAutostartEnabled() });
});

app.post('/api/autostart', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { enabled } = req.body;
  try {
    if (enabled) {
      if (!fs.existsSync(START_BAT_PATH)) {
        return res.status(400).json({ error: 'start.bat 不存在，无法启用自启动' });
      }
      enableAutostart();
      res.json({ success: true, enabled: true, message: '开机自启动已启用' });
    } else {
      disableAutostart();
      res.json({ success: true, enabled: false, message: '开机自启动已关闭' });
    }
  } catch (err) {
    res.status(500).json({ error: `操作失败: ${err.message}` });
  }
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`\n☁️  Telegram 云盘管理系统已启动（多用户模式）`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   数据库: ${path.join(__dirname, 'data.db')}`);
  console.log(`   默认管理员: admin / qwer1234`);
  console.log('');
});
