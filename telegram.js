const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * 创建代理 agent
 */
function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    if (proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
      return new SocksProxyAgent(proxyUrl);
    } else {
      return new HttpsProxyAgent(proxyUrl);
    }
  } catch (err) {
    console.error('代理创建失败:', err.message);
    return null;
  }
}

/**
 * 为每个用户创建一个独立的 Bot 控制器
 * 返回的对象持有自己的 bot 实例与代理 agent
 */
function createBotController(token, options = {}) {
  if (!token) throw new Error('Bot Token 不能为空');

  const proxyAgent = options.proxy ? createProxyAgent(options.proxy) : null;
  const apiRoot = options.api_root || 'https://api.telegram.org';

  const telegrafOptions = {};
  if (proxyAgent) {
    telegrafOptions.telegram = { agent: proxyAgent };
  }
  if (apiRoot && apiRoot !== 'https://api.telegram.org') {
    telegrafOptions.telegram = { ...telegrafOptions.telegram, apiRoot };
  }

  const bot = new Telegraf(token, telegrafOptions);
  const telegram = bot.telegram;

  async function validateBot() {
    try {
      const info = await telegram.getMe();
      return { valid: true, info };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  async function validateChannel(channelId) {
    try {
      const msg = await telegram.sendMessage(channelId, '☁️ 云盘系统连接测试成功！');
      await telegram.deleteMessage(channelId, msg.message_id);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  async function uploadFile(file, channelId) {
    const filePath = file.path;
    const fileName = file.originalname || path.basename(filePath);
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;

    const ext = path.extname(fileName).toLowerCase();
    let result;
    let fileType;

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
      fileType = 'photo';
      result = await telegram.sendPhoto(channelId, { source: filePath }, { caption: fileName });
      const photo = result.photo[result.photo.length - 1];
      const thumb = result.photo[0];
      return {
        file_id: photo.file_id,
        file_unique_id: photo.file_unique_id,
        thumb_file_id: thumb ? thumb.file_id : null,
        message_id: result.message_id,
        file_type: 'photo'
      };
    }

    if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
      fileType = 'video';
      try {
        result = await telegram.sendVideo(channelId, { source: filePath }, { caption: fileName });
        return {
          file_id: result.video.file_id,
          file_unique_id: result.video.file_unique_id,
          thumb_file_id: result.video.thumb ? result.video.thumb.file_id : null,
          message_id: result.message_id,
          file_type: 'video'
        };
      } catch {
        // 回退到文档
      }
    }

    if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) {
      fileType = 'audio';
      try {
        result = await telegram.sendAudio(channelId, { source: filePath }, { caption: fileName });
        return {
          file_id: result.audio.file_id,
          file_unique_id: result.audio.file_unique_id,
          thumb_file_id: result.audio.thumb ? result.audio.thumb.file_id : null,
          message_id: result.message_id,
          file_type: 'audio'
        };
      } catch {
        // 回退到文档
      }
    }

    fileType = 'document';
    result = await telegram.sendDocument(channelId, { source: filePath }, { caption: fileName });
    return {
      file_id: result.document.file_id,
      file_unique_id: result.document.file_unique_id,
      thumb_file_id: result.document.thumb ? result.document.thumb.file_id : null,
      message_id: result.message_id,
      file_type: 'document'
    };
  }

  async function getFileLink(fileId) {
    return await telegram.getFileLink(fileId);
  }

  async function downloadFile(fileId) {
    const link = await getFileLink(fileId);
    const axiosConfig = {
      method: 'GET',
      url: link,
      responseType: 'stream'
    };
    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent;
      axiosConfig.proxy = false;
    }
    const response = await axios(axiosConfig);
    return response.data;
  }

  async function deleteMessage(channelId, messageId) {
    await telegram.deleteMessage(channelId, messageId);
  }

  return {
    bot,
    telegram,
    proxyAgent,
    validateBot,
    validateChannel,
    uploadFile,
    getFileLink,
    downloadFile,
    deleteMessage
  };
}

module.exports = {
  createBotController,
  createProxyAgent
};
