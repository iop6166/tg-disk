const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { settingsStore } = require('./db');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

let client = null;
let loginState = {
  phoneNumber: null,
  phoneCodeHash: null,
  is2FA: false,
};

// ============ 代理配置 ============
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  try {
    // socks5://127.0.0.1:1080
    // http://127.0.0.1:7890
    const url = new URL(proxyStr);
    const host = url.hostname;
    const port = parseInt(url.port);

    if (url.protocol === 'socks5:' || url.protocol === 'socks:') {
      return {
        socksType: url.protocol === 'socks4:' ? 4 : 5,
        ip: host,
        port: port,
        ...(url.username && { userId: decodeURIComponent(url.username) }),
        ...(url.password && { password: decodeURIComponent(url.password) }),
      };
    }
    // HTTP 代理：GramJS 仅支持 SOCKS，尝试将同一端口作为 SOCKS5 混合端口
    // Clash/V2Ray 的 mixed-port 同时支持 HTTP 和 SOCKS5
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return {
        socksType: 5,
        ip: host,
        port: port,
        ...(url.username && { userId: decodeURIComponent(url.username) }),
        ...(url.password && { password: decodeURIComponent(url.password) }),
      };
    }
  } catch {
    return null;
  }
  return null;
}

// ============ 客户端管理 ============
function getClient() {
  return client;
}

function isConnected() {
  return client && client.connected;
}

function getApiCredentials() {
  return {
    apiId: parseInt(settingsStore.get('mtproto_api_id') || '0'),
    apiHash: settingsStore.get('mtproto_api_hash') || '',
  };
}

function getChannelId() {
  const cid = settingsStore.get('channel_id');
  return cid ? parseInt(cid) : null;
}

// 从已保存的 session 恢复连接
async function restoreSession() {
  const { apiId, apiHash } = getApiCredentials();
  if (!apiId || !apiHash) return false;

  const sessionStr = settingsStore.get('mtproto_session');
  if (!sessionStr) return false;

  const proxy = parseProxy(settingsStore.get('proxy') || '');
  const session = new StringSession(sessionStr);

  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    ...(proxy && { proxy }),
  });

  await client.connect();
  const authorized = await client.isUserAuthorized();
  if (!authorized) {
    client = null;
    return false;
  }
  return true;
}

// ============ 登录流程 ============
async function sendCode(phoneNumber) {
  const { apiId, apiHash } = getApiCredentials();
  if (!apiId || !apiHash) {
    throw new Error('请先在设置中配置 API ID 和 API Hash');
  }

  const proxy = parseProxy(settingsStore.get('proxy') || '');
  const session = new StringSession('');

  if (client) {
    try { await client.disconnect(); } catch {}
    client = null;
  }

  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    ...(proxy && { proxy }),
  });

  await client.connect();

  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber,
      apiId,
      apiHash,
      settings: new Api.CodeSettings(),
    })
  );

  loginState.phoneNumber = phoneNumber;
  loginState.phoneCodeHash = result.phoneCodeHash;
  loginState.is2FA = false;

  return {
    phoneCodeHash: result.phoneCodeHash,
    isRegistered: result.isCodeTypeApp,
  };
}

async function verifyCode(code) {
  if (!client || !loginState.phoneNumber) {
    throw new Error('请先发送验证码');
  }

  try {
    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: loginState.phoneNumber,
        phoneCodeHash: loginState.phoneCodeHash,
        phoneCode: code,
      })
    );

    // 登录成功，保存 session
    const session = await client.session.save();
    settingsStore.set('mtproto_session', session);
    loginState.is2FA = false;

    const user = result.user;
    return {
      success: true,
      user: {
        id: user.id.toString(),
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        phone: user.phone || '',
        username: user.username || '',
      },
    };
  } catch (err) {
    // 检查是否需要 2FA
    if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
      loginState.is2FA = true;
      return { success: false, needs2FA: true };
    }
    throw err;
  }
}

async function verify2FA(password) {
  if (!client) {
    throw new Error('客户端未初始化');
  }

  try {
    const srpResult = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = require('telegram/Password');
    const passwordCheck = await computeCheck(srpResult, password);

    const result = await client.invoke(
      new Api.auth.CheckPassword({ password: passwordCheck })
    );

    // 登录成功，保存 session
    const session = await client.session.save();
    settingsStore.set('mtproto_session', session);

    const user = result.user;
    return {
      success: true,
      user: {
        id: user.id.toString(),
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        phone: user.phone || '',
        username: user.username || '',
      },
    };
  } catch (err) {
    throw new Error('两步验证密码错误: ' + (err.message || err.errorMessage));
  }
}

async function logout() {
  if (client) {
    try {
      await client.invoke(new Api.auth.LogOut());
      await client.disconnect();
    } catch {}
    client = null;
  }
  settingsStore.set('mtproto_session', '');
  loginState = { phoneNumber: null, phoneCodeHash: null, is2FA: false };
}

async function getUserInfo() {
  if (!client || !await client.isUserAuthorized()) return null;
  const me = await client.getMe();
  return {
    id: me.id.toString(),
    firstName: me.firstName || '',
    lastName: me.lastName || '',
    phone: me.phone || '',
    username: me.username || '',
  };
}

// ============ 频道文件浏览 ============
async function getChannelFiles(offset = 0, limit = 50) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);

  // 获取包含媒体的消息
  const messages = await client.getMessages(entity, {
    offsetId: offset || undefined,
    limit: limit,
  });

  const files = [];
  for (const msg of messages) {
    if (!msg.media || msg.media instanceof Api.MessageMediaWebPage) continue;

    const fileInfo = extractFileInfo(msg);
    if (fileInfo) files.push(fileInfo);
  }

  // 最后一条消息的 id 作为下次加载的 offset
  const lastMsg = messages[messages.length - 1];
  const nextOffset = lastMsg ? lastMsg.id : null;

  return { files, nextOffset, hasMore: messages.length === limit };
}

async function searchChannelFiles(query, offset = 0, limit = 50) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);

  const messages = await client.getMessages(entity, {
    search: query,
    offsetId: offset || undefined,
    limit: limit,
    filter: new Api.InputMessagesFilterDocument(),
  });

  // 也搜索图片和视频
  const mediaMessages = await client.getMessages(entity, {
    search: query,
    offsetId: offset || undefined,
    limit: limit,
    filter: new Api.InputMessagesFilterPhotos(),
  });

  const allMessages = [...messages, ...mediaMessages];
  const files = [];
  const seenIds = new Set();

  for (const msg of allMessages) {
    if (seenIds.has(msg.id)) continue;
    seenIds.add(msg.id);
    if (!msg.media || msg.media instanceof Api.MessageMediaWebPage) continue;
    const fileInfo = extractFileInfo(msg);
    if (fileInfo) files.push(fileInfo);
  }

  const lastMsg = allMessages[allMessages.length - 1];
  const nextOffset = lastMsg ? lastMsg.id : null;

  return { files, nextOffset, hasMore: allMessages.length === limit };
}

// 修复双重编码的 UTF-8 文件名（Bot API 上传时 Latin1 乱码）
function fixEncoding(str) {
  if (!str) return str;
  try {
    // 如果字符串包含 Latin1 扩展字符（0x80-0xFF），可能是双重编码
    if (/[\u0080-\u00FF]/.test(str)) {
      const buf = Buffer.from(str, 'latin1');
      const fixed = buf.toString('utf8');
      // 只有当修复后包含 CJK 字符时才使用修复版本
      if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\u2000-\u206f]/.test(fixed)) {
        return fixed;
      }
    }
  } catch {}
  return str;
}

// 从消息中提取文件信息
function extractFileInfo(msg) {
  if (!msg.media) return null;

  let fileType = 'document';
  let name = '';
  let size = 0;
  let mimeType = 'application/octet-stream';
  let hasThumb = false;

  if (msg.media instanceof Api.MessageMediaPhoto) {
    fileType = 'photo';
    name = msg.message || `photo_${msg.id}.jpg`;
    mimeType = 'image/jpeg';
    // 获取最大尺寸的 photo
    const photo = msg.media.photo;
    if (photo && photo.sizes) {
      // 从 PhotoSize 或 PhotoSizeProgressive 获取文件大小
      for (const s of photo.sizes) {
        if (s instanceof Api.PhotoSize && s.size) {
          size = Math.max(size, s.size);
        } else if (s instanceof Api.PhotoSizeProgressive && s.sizes && s.sizes.length > 0) {
          size = Math.max(size, s.sizes[s.sizes.length - 1]);
        }
      }
      // 检查是否有缩略图（任何 PhotoSize 类型都算）
      hasThumb = photo.sizes.some(s =>
        s instanceof Api.PhotoStrippedSize ||
        s instanceof Api.PhotoCachedSize ||
        s instanceof Api.PhotoSize ||
        s instanceof Api.PhotoSizeProgressive
      );
    }
  } else if (msg.media instanceof Api.MessageMediaDocument) {
    const doc = msg.media.document;
    if (!doc) return null;

    mimeType = doc.mimeType || 'application/octet-stream';

    if (mimeType.startsWith('video/')) fileType = 'video';
    else if (mimeType.startsWith('audio/')) fileType = 'audio';
    else if (mimeType.startsWith('image/')) fileType = 'photo';
    else fileType = 'document';

    size = doc.size ? parseInt(doc.size) : 0;

    // 从 attributes 获取文件名
    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeFilename) {
          name = attr.fileName;
          break;
        }
      }
    }

    // 检查是否有缩略图
    hasThumb = !!(doc.thumbs && doc.thumbs.length > 0);
  } else {
    return null;
  }

  // 修复双重编码的文件名
  name = fixEncoding(name);
  const caption = fixEncoding(msg.message || '');

  if (!name) {
    const ext = mimeType.split('/')[1] || 'bin';
    name = `file_${msg.id}.${ext}`;
  }

  return {
    message_id: msg.id,
    name,
    size,
    mime_type: mimeType,
    file_type: fileType,
    date: msg.date,
    caption,
    has_thumb: hasThumb,
  };
}

// ============ 文件下载 ============
async function downloadChannelFile(messageId, res) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  // 使用 downloadMedia 下载
  const buffer = await client.downloadMedia(msg.media, {});

  if (Buffer.isBuffer(buffer)) {
    return buffer;
  }
  // 如果返回的是 stream
  if (buffer && typeof buffer.pipe === 'function') {
    return buffer;
  }
  throw new Error('下载失败：未知返回类型');
}

// 下载到流
async function downloadChannelFileStream(messageId) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  const buffer = await client.downloadMedia(msg.media, {});
  return Readable.from(Buffer.isBuffer(buffer) ? [buffer] : buffer);
}

// 下载缩略图 - 取较大尺寸的缩略图以保证清晰度
async function downloadChannelThumb(messageId) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  // 获取可用的缩略图尺寸列表
  let thumbs = [];
  if (msg.media instanceof Api.MessageMediaPhoto && msg.media.photo && msg.media.photo.sizes) {
    thumbs = msg.media.photo.sizes.filter(s => !(s instanceof Api.PhotoSizeEmpty));
  } else if (msg.media instanceof Api.MessageMediaDocument && msg.media.document && msg.media.document.thumbs) {
    thumbs = msg.media.document.thumbs.filter(s => !(s instanceof Api.PhotoSizeEmpty));
  }

  if (thumbs.length === 0) return null;

  // 按尺寸排序（从小到大）
  function getThumbSize(t) {
    if (t instanceof Api.PhotoStrippedSize || t instanceof Api.PhotoCachedSize) return t.bytes ? t.bytes.length : 0;
    if (t instanceof Api.PhotoSize) return t.size || 0;
    if (t instanceof Api.PhotoSizeProgressive) return t.sizes && t.sizes.length > 0 ? Math.max(...t.sizes) : 0;
    return 0;
  }
  thumbs.sort((a, b) => getThumbSize(a) - getThumbSize(b));

  // 分离需要网络下载的尺寸和内嵌尺寸
  const networkThumbs = thumbs.filter(t => !(t instanceof Api.PhotoStrippedSize) && !(t instanceof Api.PhotoCachedSize));
  const inlineThumbs = thumbs.filter(t => t instanceof Api.PhotoStrippedSize || t instanceof Api.PhotoCachedSize);

  // 优先尝试网络下载的中等尺寸缩略图（清晰且大小合理）
  // 使用字符串 type 属性（如 "m", "x"）而非对象，因为 getThumb 不识别 PhotoSizeProgressive 对象
  // Telegram 缩略图类型按大小排序: s < b < m < c < x < y < d < w
  // "m" = 320x320 适合网格显示，"x" = 1280x1280 高清但较大
  const preferredTypes = ['m', 'c', 'x', 'y', 'b', 's'];
  const availableTypes = networkThumbs.map(t => t.type).filter(Boolean);

  for (const preferred of preferredTypes) {
    if (availableTypes.includes(preferred)) {
      try {
        const buffer = await client.downloadMedia(msg.media, { thumb: preferred });
        if (Buffer.isBuffer(buffer) && buffer.length > 0) return buffer;
      } catch (err) {
        console.warn(`[thumb] download type '${preferred}' failed:`, err.message);
      }
    }
  }

  // 回退到内嵌缩略图（小但不需要网络下载）
  for (let i = inlineThumbs.length - 1; i >= 0; i--) {
    try {
      const buffer = await client.downloadMedia(msg.media, { thumb: inlineThumbs[i] });
      if (Buffer.isBuffer(buffer) && buffer.length > 0) return buffer;
    } catch {}
  }

  // 最后回退到最小的缩略图
  try {
    const buffer = await client.downloadMedia(msg.media, { thumb: 0 });
    if (Buffer.isBuffer(buffer) && buffer.length > 0) return buffer;
  } catch {}

  return null;
}

// 编辑频道消息文案（用于"重命名"caption）
async function editChannelMessageCaption(messageId, text) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  await client.editMessage(entity, {
    message: messageId,
    text: text,
  });
}

// 转发消息到频道（用于复制/剪切粘贴）
async function forwardMessagesToChannel(messageIds) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.forwardMessages(entity, {
    fromPeer: entity,
    messages: messageIds,
  });
  return messages;
}

// 获取消息文件信息（不下载文件）
async function getChannelMessageInfo(messageId) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  return extractFileInfo(msg);
}

// 直接流式传输文件到 HTTP 响应（不缓存，即时播放）
// 支持从指定偏移量开始传输（用于 Range 请求）
// maxBytes: 最多传输的字节数（用于限制 Range 请求范围）
async function streamChannelFileToResponse(messageId, res, startOffset = 0, maxBytes = 0) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  // 如果有字节限制，创建限流 Writable 流
  let outputTarget = res;
  let bytesSent = 0;
  let limitReached = false;

  if (maxBytes > 0) {
    const { Writable } = require('stream');
    outputTarget = new Writable({
      write(chunk, encoding, callback) {
        if (limitReached) {
          callback();
          return;
        }
        const remaining = maxBytes - bytesSent;
        if (remaining <= 0) {
          limitReached = true;
          if (!res.destroyed && res.writable) res.end();
          callback();
          return;
        }
        const toSend = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        bytesSent += toSend.length;
        if (!res.destroyed && res.writable) {
          res.write(toSend, () => {
            if (bytesSent >= maxBytes && !limitReached) {
              limitReached = true;
              if (!res.destroyed && res.writable) res.end();
            }
            callback();
          });
        } else {
          callback();
        }
      },
      final(callback) {
        if (!limitReached && !res.writableEnded) res.end();
        callback();
      },
    });
  }

  // 使用 downloadMedia 的 outputFile 参数直接写入响应流
  const options = { outputFile: outputTarget };
  if (startOffset > 0) {
    options.offset = startOffset;
  }

  await client.downloadMedia(msg.media, options);

  // 确保响应已结束
  if (!res.writableEnded && !limitReached) {
    res.end();
  }
}

// 下载到临时文件（用于流式播放，支持 Range 请求）
// 使用 outputFile 参数直接流式写入磁盘，避免大文件内存溢出
async function downloadChannelFileToPath(messageId, filePath) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  const messages = await client.getMessages(entity, { ids: [messageId] });
  if (!messages || messages.length === 0) throw new Error('消息不存在');

  const msg = messages[0];
  if (!msg.media) throw new Error('该消息没有文件');

  // 使用 outputFile 参数让 GramJS 直接流式写入文件，不经过内存
  const result = await client.downloadMedia(msg.media, { outputFile: filePath });
  
  // downloadMedia 返回文件路径字符串（当 outputFile 是路径时）
  const downloadedPath = typeof result === 'string' ? result : filePath;
  
  if (!fs.existsSync(downloadedPath)) {
    throw new Error('文件下载失败');
  }
  
  return fs.statSync(downloadedPath).size;
}

// ============ 文件上传 (MTProto, 支持 4GB) ============
async function uploadFile(filePath, fileName, mimeType) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);

  const result = await client.sendFile(entity, {
    file: filePath,
    caption: fileName,
    forceDocument: false,
    attributes: [
      new Api.DocumentAttributeFilename({ fileName }),
    ],
  });

  return extractFileInfo(result);
}

// ============ 删除消息 ============
async function deleteChannelMessage(messageId) {
  if (!client) throw new Error('MTProto 未连接');
  const channelId = getChannelId();
  if (!channelId) throw new Error('未配置频道 ID');

  const entity = await client.getEntity(channelId);
  await client.deleteMessages(entity, [messageId], { revoke: true });
}

module.exports = {
  parseProxy,
  getClient,
  isConnected,
  restoreSession,
  sendCode,
  verifyCode,
  verify2FA,
  logout,
  getUserInfo,
  getChannelFiles,
  searchChannelFiles,
  downloadChannelFile,
  downloadChannelFileStream,
  downloadChannelFileToPath,
  downloadChannelThumb,
  getChannelMessageInfo,
  streamChannelFileToResponse,
  uploadFile,
  deleteChannelMessage,
  editChannelMessageCaption,
  forwardMessagesToChannel,
  getApiCredentials,
};
