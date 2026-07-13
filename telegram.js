const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

let bot = null;
let botInfo = null;
let proxyAgent = null;
let apiRoot = 'https://api.telegram.org';

function getBot() {
  if (!bot) throw new Error('Telegram Bot 未初始化，请先在设置中配置 Bot Token 和频道 ID');
  return bot;
}

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
 * 初始化 Bot
 */
function initBot(token, options = {}) {
  if (!token) throw new Error('Bot Token 不能为空');

  // 设置代理
  if (options.proxy) {
    proxyAgent = createProxyAgent(options.proxy);
  }

  // 设置自定义 API 地址
  if (options.api_root) {
    apiRoot = options.api_root;
  }

  const telegrafOptions = {};
  if (proxyAgent) {
    telegrafOptions.telegram = { agent: proxyAgent };
  }
  if (apiRoot && apiRoot !== 'https://api.telegram.org') {
    telegrafOptions.telegram = { ...telegrafOptions.telegram, apiRoot };
  }

  bot = new Telegraf(token, telegrafOptions);
  return bot;
}

/**
 * 验证 Bot Token
 */
async function validateBot(token, options = {}) {
  try {
    const telegrafOptions = {};

    // 使用代理
    let agent = proxyAgent;
    if (options.proxy) {
      agent = createProxyAgent(options.proxy);
    }
    if (agent) {
      telegrafOptions.telegram = { agent };
    }

    // 使用自定义 API 地址
    let root = options.api_root || apiRoot;
    if (root && root !== 'https://api.telegram.org') {
      telegrafOptions.telegram = { ...telegrafOptions.telegram, apiRoot: root };
    }

    const tempBot = new Telegraf(token, telegrafOptions);
    const info = await tempBot.telegram.getMe();
    return { valid: true, info };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * 验证频道
 */
async function validateChannel(token, channelId, options = {}) {
  try {
    const telegrafOptions = {};

    let agent = proxyAgent;
    if (options.proxy) {
      agent = createProxyAgent(options.proxy);
    }
    if (agent) {
      telegrafOptions.telegram = { agent };
    }

    let root = options.api_root || apiRoot;
    if (root && root !== 'https://api.telegram.org') {
      telegrafOptions.telegram = { ...telegrafOptions.telegram, apiRoot: root };
    }

    const tempBot = new Telegraf(token, telegrafOptions);
    // 尝试发送一条测试消息
    const msg = await tempBot.telegram.sendMessage(channelId, '☁️ 云盘系统连接测试成功！');
    // 然后删除测试消息
    await tempBot.telegram.deleteMessage(channelId, msg.message_id);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * 上传文件到 Telegram 频道
 */
async function uploadFile(file, channelId) {
  const tg = getBot().telegram;
  const filePath = file.path;
  const fileName = file.originalname || path.basename(filePath);
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;

  const ext = path.extname(fileName).toLowerCase();
  let result;
  let fileType;

  // 图片
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
    fileType = 'photo';
    result = await tg.sendPhoto(channelId, { source: filePath }, { caption: fileName });
    const photo = result.photo[result.photo.length - 1];
    // 缩略图取最小的尺寸
    const thumb = result.photo[0];
    return {
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      thumb_file_id: thumb ? thumb.file_id : null,
      message_id: result.message_id,
      file_type: 'photo'
    };
  }

  // 视频
  if (['.mp4', '.avi', '.mov', '.mkv', '.webm'].includes(ext)) {
    fileType = 'video';
    try {
      result = await tg.sendVideo(channelId, { source: filePath }, { caption: fileName });
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

  // 音频
  if (['.mp3', '.wav', '.flac', '.ogg', '.m4a'].includes(ext)) {
    fileType = 'audio';
    try {
      result = await tg.sendAudio(channelId, { source: filePath }, { caption: fileName });
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

  // 默认：作为文档发送
  fileType = 'document';
  result = await tg.sendDocument(channelId, { source: filePath }, { caption: fileName });
  return {
    file_id: result.document.file_id,
    file_unique_id: result.document.file_unique_id,
    thumb_file_id: result.document.thumb ? result.document.thumb.file_id : null,
    message_id: result.message_id,
    file_type: 'document'
  };
}

/**
 * 获取文件下载链接
 */
async function getFileLink(fileId) {
  const tg = getBot().telegram;
  return await tg.getFileLink(fileId);
}

/**
 * 下载文件并返回流
 */
async function downloadFile(fileId) {
  const link = await getFileLink(fileId);

  // 如果有代理，使用代理下载
  const axiosConfig = {
    method: 'GET',
    url: link,
    responseType: 'stream'
  };

  if (proxyAgent) {
    axiosConfig.httpsAgent = proxyAgent;
    axiosConfig.proxy = false; // 禁用 axios 的内置代理，使用自定义 agent
  }

  const response = await axios(axiosConfig);
  return response.data;
}

/**
 * 删除 Telegram 上的消息
 */
async function deleteMessage(channelId, messageId) {
  const tg = getBot().telegram;
  await tg.deleteMessage(channelId, messageId);
}

module.exports = {
  initBot,
  getBot,
  validateBot,
  validateChannel,
  uploadFile,
  getFileLink,
  downloadFile,
  deleteMessage
};
