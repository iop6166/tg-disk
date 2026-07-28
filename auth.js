const crypto = require('crypto');
const { userStore, sessionStore } = require('./db');

// 解析 Cookie 头（避免引入额外依赖）
function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isHttps(req) {
  return req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    req.headers['x-forwarded-ssl'] === 'on';
}

// 设置会话 Cookie
function setSessionCookie(res, token) {
  const secure = isHttps(res.req) ? ' Secure;' : '';
  res.cookie('tg_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 天
    secure: isHttps(res.req)
  });
}

// 创建会话（登录成功时调用）
function createSession(userId) {
  const token = generateToken();
  sessionStore.create(token, userId);
  return token;
}

// 根据 token 获取用户
function getUserByToken(token) {
  if (!token) return null;
  const session = sessionStore.get(token);
  if (!session) return null;
  return userStore.getById(session.user_id);
}

// 校验是否已登录的中间件
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.tg_session;
  const user = getUserByToken(token);
  if (!user) {
    return res.status(401).json({ error: '未登录或会话已过期，请重新登录' });
  }
  req.user = user;
  next();
}

// 校验管理员权限
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

module.exports = {
  parseCookies,
  generateToken,
  setSessionCookie,
  createSession,
  destroySession: (token) => sessionStore.delete(token),
  getUserByToken,
  requireAuth,
  requireAdmin
};
