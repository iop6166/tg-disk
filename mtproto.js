const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');

// ============ 代理配置 ============
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  try {
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

// 修复双重编码的 UTF-8 文件名（Bot API 上传时 Latin1 乱码）
function fixEncoding(str) {
  if (!str) return str;
  try {
    if (/[\u0080-\u00FF]/.test(str)) {
      const buf = Buffer.from(str, 'latin1');
      const fixed = buf.toString('utf8');
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
    const photo = msg.media.photo;
    if (photo && photo.sizes) {
      for (const s of photo.sizes) {
        if (s instanceof Api.PhotoSize && s.size) {
          size = Math.max(size, s.size);
        } else if (s instanceof Api.PhotoSizeProgressive && s.sizes && s.sizes.length > 0) {
          size = Math.max(size, s.sizes[s.sizes.length - 1]);
        }
      }
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

    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeFilename) {
          name = attr.fileName;
          break;
        }
      }
    }

    hasThumb = !!(doc.thumbs && doc.thumbs.length > 0);
  } else {
    return null;
  }

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

/**
 * 为每个用户创建一个独立的 MTProto 控制器
 * cfg: { apiId, apiHash, session, proxy, channelId, persistSession }
 * persistSession(sessionStr) 用于把登录后的 session 写回数据库
 */
function createMtprotoController(cfg) {
  const apiId = parseInt(cfg.apiId || '0');
  const apiHash = cfg.apiHash || '';
  const channelId = cfg.channelId ? parseInt(cfg.channelId) : null;
  const proxy = parseProxy(cfg.proxy || '');
  const persistSession = typeof cfg.persistSession === 'function' ? cfg.persistSession : () => {};

  let client = null;
  let loginState = {
    phoneNumber: null,
    phoneCodeHash: null,
    is2FA: false,
  };

  function getClient() {
    return client;
  }

  function isConnected() {
    return client && client.connected;
  }

  function getApiCredentials() {
    return { apiId, apiHash };
  }

  function getChannelId() {
    return channelId;
  }

  async function restoreSession() {
    if (!apiId || !apiHash) return false;
    const sessionStr = cfg.session;
    if (!sessionStr) return false;

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

  async function sendCode(phoneNumber) {
    if (!apiId || !apiHash) {
      throw new Error('请先在设置中配置 API ID 和 API Hash');
    }

    if (client) {
      try { await client.disconnect(); } catch {}
      client = null;
    }

    const session = new StringSession('');
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

      const session = await client.session.save();
      persistSession(session);
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

      const session = await client.session.save();
      persistSession(session);

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
    persistSession('');
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

  async function getChannelFiles(offset = 0, limit = 50) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
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

    const lastMsg = messages[messages.length - 1];
    const nextOffset = lastMsg ? lastMsg.id : null;
    return { files, nextOffset, hasMore: messages.length === limit };
  }

  async function searchChannelFiles(query, offset = 0, limit = 50) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, {
      search: query,
      offsetId: offset || undefined,
      limit: limit,
      filter: new Api.InputMessagesFilterDocument(),
    });

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

  async function downloadChannelFile(messageId) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    const buffer = await client.downloadMedia(msg.media, {});
    if (Buffer.isBuffer(buffer)) return buffer;
    if (buffer && typeof buffer.pipe === 'function') return buffer;
    throw new Error('下载失败：未知返回类型');
  }

  async function downloadChannelFileStream(messageId) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    const buffer = await client.downloadMedia(msg.media, {});
    return Readable.from(Buffer.isBuffer(buffer) ? [buffer] : buffer);
  }

  async function downloadChannelThumb(messageId) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    let thumbs = [];
    if (msg.media instanceof Api.MessageMediaPhoto && msg.media.photo && msg.media.photo.sizes) {
      thumbs = msg.media.photo.sizes.filter(s => !(s instanceof Api.PhotoSizeEmpty));
    } else if (msg.media instanceof Api.MessageMediaDocument && msg.media.document && msg.media.document.thumbs) {
      thumbs = msg.media.document.thumbs.filter(s => !(s instanceof Api.PhotoSizeEmpty));
    }

    if (thumbs.length === 0) return null;

    function getThumbSize(t) {
      if (t instanceof Api.PhotoStrippedSize || t instanceof Api.PhotoCachedSize) return t.bytes ? t.bytes.length : 0;
      if (t instanceof Api.PhotoSize) return t.size || 0;
      if (t instanceof Api.PhotoSizeProgressive) return t.sizes && t.sizes.length > 0 ? Math.max(...t.sizes) : 0;
      return 0;
    }
    thumbs.sort((a, b) => getThumbSize(a) - getThumbSize(b));

    const networkThumbs = thumbs.filter(t => !(t instanceof Api.PhotoStrippedSize) && !(t instanceof Api.PhotoCachedSize));
    const inlineThumbs = thumbs.filter(t => t instanceof Api.PhotoStrippedSize || t instanceof Api.PhotoCachedSize);

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

    for (let i = inlineThumbs.length - 1; i >= 0; i--) {
      try {
        const buffer = await client.downloadMedia(msg.media, { thumb: inlineThumbs[i] });
        if (Buffer.isBuffer(buffer) && buffer.length > 0) return buffer;
      } catch {}
    }

    try {
      const buffer = await client.downloadMedia(msg.media, { thumb: 0 });
      if (Buffer.isBuffer(buffer) && buffer.length > 0) return buffer;
    } catch {}

    return null;
  }

  async function editChannelMessageCaption(messageId, text) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    await client.editMessage(entity, { message: messageId, text });
  }

  async function forwardMessagesToChannel(messageIds) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.forwardMessages(entity, {
      fromPeer: entity,
      messages: messageIds,
    });
    return messages;
  }

  async function getChannelMessageInfo(messageId) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    return extractFileInfo(msg);
  }

  async function streamChannelFileToResponse(messageId, res, startOffset = 0, maxBytes = 0) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    let outputTarget = res;
    let bytesSent = 0;
    let limitReached = false;

    if (maxBytes > 0) {
      outputTarget = new Writable({
        write(chunk, encoding, callback) {
          if (limitReached) { callback(); return; }
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

    const options = { outputFile: outputTarget };
    if (startOffset > 0) options.offset = startOffset;

    await client.downloadMedia(msg.media, options);

    if (!res.writableEnded && !limitReached) res.end();
  }

  async function downloadChannelFileToPath(messageId, filePath) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const messages = await client.getMessages(entity, { ids: [messageId] });
    if (!messages || messages.length === 0) throw new Error('消息不存在');

    const msg = messages[0];
    if (!msg.media) throw new Error('该消息没有文件');

    const result = await client.downloadMedia(msg.media, { outputFile: filePath });
    const downloadedPath = typeof result === 'string' ? result : filePath;

    if (!fs.existsSync(downloadedPath)) throw new Error('文件下载失败');
    return fs.statSync(downloadedPath).size;
  }

  async function uploadFile(filePath, fileName, mimeType) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    const result = await client.sendFile(entity, {
      file: filePath,
      caption: fileName,
      forceDocument: false,
      attributes: [new Api.DocumentAttributeFilename({ fileName })],
    });

    return extractFileInfo(result);
  }

  async function deleteChannelMessage(messageId) {
    if (!client) throw new Error('MTProto 未连接');
    if (!channelId) throw new Error('未配置频道 ID');

    const entity = await client.getEntity(channelId);
    await client.deleteMessages(entity, [messageId], { revoke: true });
  }

  return {
    getClient,
    isConnected,
    getApiCredentials,
    getChannelId,
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
  };
}

module.exports = {
  parseProxy,
  createMtprotoController,
};
