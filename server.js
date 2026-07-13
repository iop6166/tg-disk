const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mimeTypes = require('mime-types');
require('dotenv').config();

const { settingsStore, folderStore, fileStore } = require('./db');
const tg = require('./telegram');
const mtproto = require('./mtproto');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// 临时文件存储
const tmpDir = path.join(os.tmpdir(), 'tg-cloud-drive-uploads');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: 2000 * 1024 * 1024 } // 2GB（本地 Bot API Server 支持）
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 中间件 ============
function getConfig() {
  let token = settingsStore.get('bot_token') || process.env.BOT_TOKEN || '';
  let channelId = settingsStore.get('channel_id') || process.env.CHANNEL_ID || '';
  if (channelId) channelId = parseInt(channelId);
  return { token, channelId };
}

function getTgOptions() {
  return {
    proxy: settingsStore.get('proxy') || '',
    api_root: settingsStore.get('api_root') || ''
  };
}

function ensureConfigured(req, res, next) {
  const { token, channelId } = getConfig();
  if (!token || !channelId) {
    return res.status(503).json({ error: '请先在设置页面配置 Bot Token 和频道 ID' });
  }
  // 确保 bot 已初始化（带代理配置）
  try {
    tg.getBot();
  } catch {
    tg.initBot(token, getTgOptions());
  }
  next();
}

// ============ 设置 API ============
app.get('/api/settings', (req, res) => {
  const all = settingsStore.getAll();
  // 脱敏返回 token
  const token = all.bot_token || process.env.BOT_TOKEN || '';
  const channelId = all.channel_id || process.env.CHANNEL_ID || '';
  res.json({
    configured: !!(token && channelId),
    bot_token_masked: token ? token.substring(0, 10) + '****' : '',
    channel_id: channelId,
    bot_username: all.bot_username || '',
    proxy: all.proxy || '',
    api_root: all.api_root || '',
    mtproto_api_id: all.mtproto_api_id || '',
    mtproto_api_hash: all.mtproto_api_hash ? all.mtproto_api_hash.substring(0, 8) + '****' : ''
  });
});

app.post('/api/settings', async (req, res) => {
  const { bot_token, channel_id, force_save, proxy, api_root } = req.body;

  // 保存代理设置
  if (proxy !== undefined) {
    settingsStore.set('proxy', proxy || '');
  }

  // 保存自定义 API 地址
  if (api_root !== undefined) {
    settingsStore.set('api_root', api_root || '');
  }

  const savedProxy = settingsStore.get('proxy') || '';
  const savedApiRoot = settingsStore.get('api_root') || '';
  const tgOptions = { proxy: savedProxy, api_root: savedApiRoot };

  if (bot_token) {
    if (force_save) {
      // 跳过验证，直接保存
      settingsStore.set('bot_token', bot_token);
      tg.initBot(bot_token, tgOptions);
    } else {
      // 验证 token
      const validation = await tg.validateBot(bot_token, tgOptions);
      if (!validation.valid) {
        return res.status(400).json({ error: `Bot Token 验证失败: ${validation.error}` });
      }
      settingsStore.set('bot_token', bot_token);
      settingsStore.set('bot_username', validation.info.username);
      tg.initBot(bot_token, tgOptions);
    }
  } else if (proxy !== undefined || api_root !== undefined) {
    // 仅更新代理/API地址，重新初始化已有 token 的 bot
    const existingToken = settingsStore.get('bot_token') || process.env.BOT_TOKEN;
    if (existingToken) {
      tg.initBot(existingToken, tgOptions);
    }
  }

  if (channel_id) {
    const parsedId = parseInt(channel_id);
    if (!force_save) {
      const token = settingsStore.get('bot_token') || process.env.BOT_TOKEN;
      if (token) {
        const chValidation = await tg.validateChannel(token, parsedId, tgOptions);
        if (!chValidation.valid) {
          return res.status(400).json({ error: `频道验证失败: ${chValidation.error}` });
        }
      }
    }
    settingsStore.set('channel_id', parsedId.toString());
  }

  res.json({ success: true, message: force_save ? '配置已保存（跳过验证）' : '配置已保存并验证通过' });
});

// ============ 文件列表 API ============
app.get('/api/files', (req, res) => {
  const folderId = req.query.folder_id ? parseInt(req.query.folder_id) : null;
  const files = fileStore.getByFolder(folderId);
  res.json(files);
});

app.get('/api/files/search', (req, res) => {
  const q = req.query.q || '';
  if (!q) return res.json([]);
  const files = fileStore.search(q);
  res.json(files);
});

app.get('/api/files/:id', (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在' });
  res.json(file);
});

// ============ 文件上传 API ============
app.post('/api/upload', ensureConfigured, upload.array('files', 20), async (req, res) => {
  const { channelId } = getConfig();
  const apiRoot = settingsStore.get('api_root') || '';
  const isLocalApi = apiRoot && !apiRoot.includes('api.telegram.org');
  const folderId = req.body.folder_id ? parseInt(req.body.folder_id) : null;
  const results = [];
  const errors = [];

  for (const file of req.files) {
    try {
      // 修复 multer originalname 编码问题（Latin1 → UTF-8）
      const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

      // 云端 Bot API 限制 50MB
      if (!isLocalApi && file.size > 50 * 1024 * 1024) {
        errors.push({
          file: originalName,
          error: '文件超过 50MB（Telegram 云端 Bot API 限制）。如需上传大文件，请在设置中配置本地 Bot API Server 地址。'
        });
        try { fs.unlinkSync(file.path); } catch {}
        continue;
      }

      const tgResult = await tg.uploadFile(file, channelId);
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
        folder_id: folderId
      });
      results.push(record);
    } catch (err) {
      // 尝试解码文件名用于错误提示
      const displayName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      console.error('上传失败:', displayName, err.message);
      errors.push({ file: displayName, error: err.message });
    } finally {
      // 清理临时文件
      try { fs.unlinkSync(file.path); } catch {}
    }
  }

  res.json({ success: results, errors });
});

// ============ 文件下载 API ============
app.get('/api/download/:id', ensureConfigured, async (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在' });

  try {
    const stream = await tg.downloadFile(file.file_id);
    // RFC 5987 格式，兼容中文文件名
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
app.get('/api/preview/:id', ensureConfigured, async (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在' });

  try {
    // 直接通过服务器代理流式返回文件内容（走代理，不暴露 Telegram 直链）
    const stream = await tg.downloadFile(file.file_id);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.size);
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: `预览失败: ${err.message}` });
  }
});

// ============ 缩略图 API ============
app.get('/api/thumb/:id', ensureConfigured, async (req, res) => {
  const file = fileStore.getById(parseInt(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (!file.thumb_file_id) return res.status(404).json({ error: '无缩略图' });

  try {
    const stream = await tg.downloadFile(file.thumb_file_id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: `缩略图获取失败: ${err.message}` });
  }
});

// ============ 文件操作 API ============
app.delete('/api/files/:id', ensureConfigured, async (req, res) => {
  const { channelId } = getConfig();
  const file = fileStore.getById(parseInt(req.params.id));
  if (!file) return res.status(404).json({ error: '文件不存在' });

  try {
    // 尝试删除 Telegram 上的消息
    await tg.deleteMessage(channelId, file.message_id);
  } catch (err) {
    console.warn('删除 Telegram 消息失败:', err.message);
  }

  fileStore.delete(file.id);
  res.json({ success: true });
});

app.patch('/api/files/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, folder_id } = req.body;
  let file = fileStore.getById(id);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  if (name) file = fileStore.rename(id, name);
  if (folder_id !== undefined) file = fileStore.move(id, folder_id === 0 ? null : folder_id);

  res.json(file);
});

// ============ 文件夹 API ============
app.get('/api/folders', (req, res) => {
  const parentId = req.query.parent_id ? parseInt(req.query.parent_id) : null;
  const folders = folderStore.getByParent(parentId);
  res.json(folders);
});

app.get('/api/folders/path/:id', (req, res) => {
  const id = req.params.id === '0' ? null : parseInt(req.params.id);
  const path = folderStore.getPath(id);
  res.json(path);
});

app.post('/api/folders', (req, res) => {
  const { name, parent_id } = req.body;
  if (!name) return res.status(400).json({ error: '文件夹名称不能为空' });
  const folder = folderStore.create(name, parent_id ? parseInt(parent_id) : null);
  res.json(folder);
});

app.patch('/api/folders/:id', (req, res) => {
  const { name } = req.body;
  const folder = folderStore.rename(parseInt(req.params.id), name);
  res.json(folder);
});

app.delete('/api/folders/:id', (req, res) => {
  folderStore.delete(parseInt(req.params.id));
  res.json({ success: true });
});

// ============ 统计 API ============
app.get('/api/stats', (req, res) => {
  const fileCount = fileStore.count();
  const totalSize = fileStore.totalSize();
  const byType = fileStore.statsByType();
  const recent = fileStore.recent(5);

  res.json({
    file_count: fileCount,
    total_size: totalSize,
    by_type: byType,
    recent_files: recent
  });
});

// ============ MTProto API ============

// MTProto 状态
app.get('/api/mtproto/status', async (req, res) => {
  try {
    const { apiId, apiHash } = mtproto.getApiCredentials();
    const hasSession = !!settingsStore.get('mtproto_session');

    if (mtproto.isConnected()) {
      const userInfo = await mtproto.getUserInfo();
      return res.json({
        connected: true,
        logged_in: !!userInfo,
        user: userInfo,
        has_api: !!(apiId && apiHash),
      });
    }

    // 尝试恢复 session
    if (hasSession && apiId && apiHash) {
      const restored = await mtproto.restoreSession();
      if (restored) {
        const userInfo = await mtproto.getUserInfo();
        return res.json({
          connected: true,
          logged_in: !!userInfo,
          user: userInfo,
          has_api: true,
        });
      }
    }

    res.json({
      connected: false,
      logged_in: false,
      user: null,
      has_api: !!(apiId && apiHash),
    });
  } catch (err) {
    res.json({
      connected: false,
      logged_in: false,
      user: null,
      has_api: !!mtproto.getApiCredentials().apiId,
      error: err.message,
    });
  }
});

// 配置 API ID / API Hash
app.post('/api/mtproto/config', (req, res) => {
  const { api_id, api_hash } = req.body;
  if (api_id) settingsStore.set('mtproto_api_id', api_id.toString());
  if (api_hash) settingsStore.set('mtproto_api_hash', api_hash);
  res.json({ success: true, message: 'API 配置已保存' });
});

// 发送验证码
app.post('/api/mtproto/send-code', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) return res.status(400).json({ error: '请输入手机号' });

  try {
    const result = await mtproto.sendCode(phone_number);
    res.json({ success: true, isRegistered: result.isRegistered });
  } catch (err) {
    res.status(400).json({ error: `发送验证码失败: ${err.message || err.errorMessage}` });
  }
});

// 验证验证码
app.post('/api/mtproto/verify-code', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请输入验证码' });

  try {
    const result = await mtproto.verifyCode(code);
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
app.post('/api/mtproto/verify-2fa', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '请输入密码' });

  try {
    const result = await mtproto.verify2FA(password);
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
app.post('/api/mtproto/logout', async (req, res) => {
  try {
    await mtproto.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 频道文件列表
app.get('/api/mtproto/channel/files', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const result = await mtproto.getChannelFiles(offset, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道搜索
app.get('/api/mtproto/channel/search', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const q = req.query.q || '';
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const result = await mtproto.searchChannelFiles(q, offset);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件下载
app.get('/api/mtproto/channel/download/:messageId', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    const stream = await mtproto.downloadChannelFileStream(messageId);
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
app.get('/api/mtproto/channel/preview/:messageId', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    const stream = await mtproto.downloadChannelFileStream(messageId);
    const mimeType = req.query.mime || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件缩略图
app.get('/api/mtproto/channel/thumb/:messageId', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    const buffer = await mtproto.downloadChannelThumb(messageId);
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
app.get('/api/mtproto/channel/stream/:messageId', async (req, res) => {
  // 增加超时时间到 30 分钟，大文件下载需要时间
  req.setTimeout(1800000);
  res.setTimeout(1800000);

  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    const mimeType = req.query.mime || 'application/octet-stream';

    // 先获取文件信息（不下载，从消息元数据读取大小）
    const fileInfo = await mtproto.getChannelMessageInfo(messageId);
    const fileSize = fileInfo.size;

    // 临时缓存目录
    const cacheDir = path.join(os.tmpdir(), 'tg-cloud-drive-cache');
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, `msg_${messageId}`);

    // 检查缓存文件是否完整（大小匹配）
    const cacheExists = fs.existsSync(cacheFile) && fs.statSync(cacheFile).size === fileSize;

    if (cacheExists) {
      // ===== 从缓存提供（快速，完整 Range 支持）=====
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

    // ===== 无缓存：直接从 Telegram 流式传输 =====
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

      // 直接从 Telegram 流式传输到客户端（即时播放，无需等待完整下载）
      // 使用 offset 参数从指定位置开始下载，maxBytes 限制传输量
      await mtproto.streamChannelFileToResponse(messageId, res, start, chunkSize);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
        'X-Accel-Buffering': 'no',
      });

      // 直接从 Telegram 流式传输（从头开始）
      await mtproto.streamChannelFileToResponse(messageId, res, 0, 0);
    }

    // 后台异步缓存完整文件（下次播放可从缓存快速读取）
    if (!fs.existsSync(cacheFile)) {
      mtproto.downloadChannelFileToPath(messageId, cacheFile).catch(err => {
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
app.delete('/api/mtproto/channel/files/:messageId', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    await mtproto.deleteChannelMessage(messageId);

    // 清理缓存文件
    const cacheFile = path.join(os.tmpdir(), 'tg-cloud-drive-cache', `msg_${messageId}`);
    try { fs.unlinkSync(cacheFile); } catch {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件重命名（编辑消息文案）
app.patch('/api/mtproto/channel/files/:messageId', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const messageId = parseInt(req.params.messageId);
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '名称不能为空' });
    await mtproto.editChannelMessageCaption(messageId, name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 频道文件转发（复制/剪切粘贴）
app.post('/api/mtproto/channel/forward', async (req, res) => {
  try {
    if (!mtproto.isConnected()) {
      const restored = await mtproto.restoreSession();
      if (!restored) return res.status(403).json({ error: 'MTProto 未登录' });
    }
    const { message_ids, delete_original } = req.body;
    if (!message_ids || !Array.isArray(message_ids) || message_ids.length === 0) {
      return res.status(400).json({ error: '请选择要粘贴的文件' });
    }

    // 转发消息
    await mtproto.forwardMessagesToChannel(message_ids);

    // 如果是剪切，删除原消息
    if (delete_original) {
      for (const msgId of message_ids) {
        try {
          await mtproto.deleteChannelMessage(msgId);
          // 清理缓存
          const cacheFile = path.join(os.tmpdir(), 'tg-cloud-drive-cache', `msg_${msgId}`);
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
app.post('/api/files/copy', (req, res) => {
  const { ids, folder_id } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择要复制的文件' });
  }
  const targetFolder = folder_id === 0 ? null : folder_id;
  const results = [];
  for (const id of ids) {
    const file = fileStore.copy(parseInt(id), targetFolder);
    if (file) results.push(file);
  }
  res.json({ success: true, count: results.length });
});

// Bot API 文件剪切（移动）
app.post('/api/files/move', (req, res) => {
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

const { execSync } = require('child_process');

// ============ 开机自启动 API ============
const START_BAT_PATH = path.join(__dirname, 'start.bat');
const AUTOSTART_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const AUTOSTART_REG_NAME = 'TelegramCloudDrive';

// PowerShell 注册表路径格式：HKCU:\Software\...
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
  // 使用 wscript 静默运行 start.bat（通过 VBS）
  const vbsPath = path.join(__dirname, 'autostart.vbs');
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "cmd /c ""${START_BAT_PATH}""", 0, False\nSet WshShell = Nothing\n`;
  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
  // 注册表项指向 wscript 运行该 VBS
  const regValue = `wscript.exe "${vbsPath}"`;
  // 用 PowerShell 写注册表（避免 reg 命令被安全策略阻止）
  const escapedValue = regValue.replace(/'/g, "''");
  const psCmd = `powershell -NoProfile -Command "Set-ItemProperty -Path '${PS_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -Value '${escapedValue}' -Force"`;
  execSync(psCmd);
}

function disableAutostart() {
  try {
    const psCmd = `powershell -NoProfile -Command "Remove-ItemProperty -Path '${PS_REG_KEY}' -Name '${AUTOSTART_REG_NAME}' -ErrorAction SilentlyContinue"`;
    execSync(psCmd);
  } catch {
    // 键不存在，忽略
  }
  // 清理 VBS
  const vbsPath = path.join(__dirname, 'autostart.vbs');
  try { fs.unlinkSync(vbsPath); } catch {}
}

app.get('/api/autostart', (req, res) => {
  const enabled = isAutostartEnabled();
  res.json({ enabled });
});

app.post('/api/autostart', (req, res) => {
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
// 初始化 bot（如果已配置，必须带代理参数）
const { token: initToken } = getConfig();
if (initToken) {
  try {
    const opts = getTgOptions();
    tg.initBot(initToken, opts);
    console.log(`✅ Telegram Bot 已初始化${opts.proxy ? ' (代理: ' + opts.proxy + ')' : ' (直连)'}`);
  } catch (err) {
    console.error('❌ Bot 初始化失败:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`\n☁️  Telegram 云盘管理系统已启动`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   数据库: ${path.join(__dirname, 'data.db')}`);

  // 尝试恢复 MTProto session
  const { apiId, apiHash } = mtproto.getApiCredentials();
  const hasSession = !!settingsStore.get('mtproto_session');
  if (apiId && apiHash && hasSession) {
    mtproto.restoreSession()
      .then(ok => {
        if (ok) console.log('   ✅ MTProto 已连接（session 恢复）');
        else console.log('   ⚠️  MTProto session 已过期，需重新登录');
      })
      .catch(err => console.log('   ⚠️  MTProto 恢复失败:', err.message));
  } else {
    console.log('   ℹ️  MTProto 未配置（需在设置中配置 API ID/Hash 并登录）');
  }
  console.log('');
});
