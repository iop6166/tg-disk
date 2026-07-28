const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 初始化数据库表
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime_type TEXT,
    file_type TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_unique_id TEXT,
    thumb_file_id TEXT,
    message_id INTEGER NOT NULL,
    folder_id INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_configs (
    user_id INTEGER PRIMARY KEY,
    bot_token TEXT,
    channel_id TEXT,
    proxy TEXT,
    api_root TEXT,
    mtproto_api_id TEXT,
    mtproto_api_hash TEXT,
    mtproto_session TEXT,
    bot_username TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
  CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
  CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
`);

// 迁移：为旧数据库添加 thumb_file_id 列
try {
  db.prepare('SELECT thumb_file_id FROM files LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE files ADD COLUMN thumb_file_id TEXT');
  console.log('📦 数据库迁移：已添加 thumb_file_id 列');
}

// 迁移：为旧数据库添加 user_id 列（多用户隔离）
try {
  db.prepare('SELECT user_id FROM files LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE files ADD COLUMN user_id INTEGER');
  console.log('📦 数据库迁移：files 表已添加 user_id 列');
}
try {
  db.prepare('SELECT user_id FROM folders LIMIT 0').get();
} catch {
  db.exec('ALTER TABLE folders ADD COLUMN user_id INTEGER');
  console.log('📦 数据库迁移：folders 表已添加 user_id 列');
}

// 索引在 user_id 列存在后再创建（避免旧库直接 CREATE INDEX 报错）
db.exec('CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id)');

// ============ 密码工具 ============
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const computed = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============ 用户 ============
const userStore = {
  create(username, password, isAdmin = false) {
    const { hash, salt } = hashPassword(password);
    const result = db.prepare(
      'INSERT INTO users (username, password_hash, salt, is_admin) VALUES (?, ?, ?, ?)'
    ).run(username, hash, salt, isAdmin ? 1 : 0);
    return this.getById(result.lastInsertRowid);
  },
  getByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  getById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  verify(username, password) {
    const user = this.getByUsername(username);
    if (!user) return null;
    if (!verifyPassword(password, user.password_hash, user.salt)) return null;
    return user;
  },
  setPassword(userId, password) {
    const { hash, salt } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, userId);
    return true;
  },
  count() {
    return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  }
};

// 自动创建管理员账号（首次启动）
// 默认管理员密码从环境变量 ADMIN_PASSWORD 读取；未设置时回退到一个非生产默认口令。
// 注意：不要在此处硬编码真实口令，避免公开仓库泄露管理密码。部署时请通过环境变量设置强密码。
function seedAdmin() {
  const defaultAdminPassword = process.env.ADMIN_PASSWORD || 'tg-disk-admin';
  if (userStore.count() === 0) {
    const admin = userStore.create('admin', defaultAdminPassword, true);
    console.log('🔑 已创建默认管理员账号: admin（密码取自环境变量 ADMIN_PASSWORD，未设置时为内置默认口令，请尽快登录修改）');
    return admin;
  }
  // 确保 admin 账号存在
  let admin = userStore.getByUsername('admin');
  if (!admin) {
    admin = userStore.create('admin', defaultAdminPassword, true);
    console.log('🔑 已补充管理员账号: admin（请使用首次部署时设置的密码登录）');
  }
  return admin;
}

// ============ 用户配置（每用户独立的 Telegram 绑定）============
const userConfigStore = {
  get(userId) {
    const row = db.prepare('SELECT * FROM user_configs WHERE user_id = ?').get(userId);
    if (row) return row;
    return {
      user_id: userId,
      bot_token: '', channel_id: '', proxy: '', api_root: '',
      mtproto_api_id: '', mtproto_api_hash: '', mtproto_session: '', bot_username: ''
    };
  },
  set(userId, cfg) {
    const cur = this.get(userId);
    const bot_token = cfg.bot_token !== undefined ? cfg.bot_token : cur.bot_token;
    const channel_id = cfg.channel_id !== undefined ? cfg.channel_id : cur.channel_id;
    const proxy = cfg.proxy !== undefined ? cfg.proxy : cur.proxy;
    const api_root = cfg.api_root !== undefined ? cfg.api_root : cur.api_root;
    const mtproto_api_id = cfg.mtproto_api_id !== undefined ? cfg.mtproto_api_id : cur.mtproto_api_id;
    const mtproto_api_hash = cfg.mtproto_api_hash !== undefined ? cfg.mtproto_api_hash : cur.mtproto_api_hash;
    const mtproto_session = cfg.mtproto_session !== undefined ? cfg.mtproto_session : cur.mtproto_session;
    const bot_username = cfg.bot_username !== undefined ? cfg.bot_username : cur.bot_username;
    db.prepare(`
      INSERT INTO user_configs (user_id, bot_token, channel_id, proxy, api_root, mtproto_api_id, mtproto_api_hash, mtproto_session, bot_username, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        bot_token = excluded.bot_token,
        channel_id = excluded.channel_id,
        proxy = excluded.proxy,
        api_root = excluded.api_root,
        mtproto_api_id = excluded.mtproto_api_id,
        mtproto_api_hash = excluded.mtproto_api_hash,
        mtproto_session = excluded.mtproto_session,
        bot_username = excluded.bot_username,
        updated_at = datetime('now')
    `).run(userId, bot_token, channel_id, proxy, api_root, mtproto_api_id, mtproto_api_hash, mtproto_session, bot_username);
    return this.get(userId);
  },
  setKey(userId, key, value) {
    const cur = this.get(userId);
    cur[key] = value;
    this.set(userId, cur);
  }
};

// ============ 会话 ============
const sessionStore = {
  create(token, userId) {
    db.prepare('INSERT INTO user_sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  },
  get(token) {
    return db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token);
  },
  delete(token) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  },
  deleteAllForUser(userId) {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  }
};

// ============ 设置 ============
const settingsStore = {
  get(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run(key, value, value);
  },
  getAll() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }
};

// ============ 文件夹 ============
const folderStore = {
  create(name, parentId, userId) {
    const result = db.prepare('INSERT INTO folders (name, parent_id, user_id) VALUES (?, ?, ?)').run(name, parentId || null, userId || null);
    return this.getById(result.lastInsertRowid);
  },
  getById(id) {
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  },
  getByParent(parentId, userId) {
    if (parentId === null || parentId === undefined) {
      return db.prepare('SELECT * FROM folders WHERE parent_id IS NULL AND user_id = ? ORDER BY name').all(userId);
    }
    return db.prepare('SELECT * FROM folders WHERE parent_id = ? AND user_id = ? ORDER BY name').all(parentId, userId);
  },
  getPath(id) {
    const pathList = [];
    let current = this.getById(id);
    while (current) {
      pathList.unshift(current);
      current = current.parent_id ? this.getById(current.parent_id) : null;
    }
    return pathList;
  },
  delete(id) {
    // 递归删除子文件夹
    const children = this.getByParent(id, null);
    for (const child of children) {
      this.delete(child.id);
    }
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  },
  rename(id, name) {
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    return this.getById(id);
  }
};

// ============ 文件 ============
const fileStore = {
  create(data) {
    const result = db.prepare(`
      INSERT INTO files (name, original_name, size, mime_type, file_type, file_id, file_unique_id, thumb_file_id, message_id, folder_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.name,
      data.original_name,
      data.size,
      data.mime_type,
      data.file_type,
      data.file_id,
      data.file_unique_id,
      data.thumb_file_id || null,
      data.message_id,
      data.folder_id || null,
      data.user_id || null
    );
    return this.getById(result.lastInsertRowid);
  },
  getById(id, userId) {
    if (userId === undefined || userId === null) {
      return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    }
    return db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(id, userId);
  },
  getByFolder(folderId, userId) {
    if (folderId === null || folderId === undefined) {
      return db.prepare('SELECT * FROM files WHERE folder_id IS NULL AND user_id = ? ORDER BY uploaded_at DESC').all(userId);
    }
    return db.prepare('SELECT * FROM files WHERE folder_id = ? AND user_id = ? ORDER BY uploaded_at DESC').all(folderId, userId);
  },
  search(query, userId) {
    const pattern = `%${query}%`;
    return db.prepare('SELECT * FROM files WHERE name LIKE ? AND user_id = ? ORDER BY uploaded_at DESC').all(pattern, userId);
  },
  delete(id) {
    const file = this.getById(id);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return file;
  },
  rename(id, name) {
    db.prepare('UPDATE files SET name = ? WHERE id = ?').run(name, id);
    return this.getById(id);
  },
  move(id, folderId) {
    db.prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(folderId, id);
    return this.getById(id);
  },
  copy(id, folderId, userId) {
    const file = this.getById(id, userId);
    if (!file) return null;
    const result = db.prepare(`
      INSERT INTO files (name, original_name, size, mime_type, file_type, file_id, file_unique_id, thumb_file_id, message_id, folder_id, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file.name, file.original_name, file.size, file.mime_type,
      file.file_type, file.file_id, file.file_unique_id, file.thumb_file_id,
      file.message_id, folderId || null, file.user_id
    );
    return this.getById(result.lastInsertRowid);
  },
  getByIds(ids, userId) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM files WHERE id IN (${placeholders}) AND user_id = ?`).all(...ids, userId);
  },
  count(userId) {
    return db.prepare('SELECT COUNT(*) as count FROM files WHERE user_id = ?').get(userId).count;
  },
  totalSize(userId) {
    const result = db.prepare('SELECT SUM(size) as total FROM files WHERE user_id = ?').get(userId);
    return result.total || 0;
  },
  statsByType(userId) {
    return db.prepare(`
      SELECT file_type, COUNT(*) as count, SUM(size) as total_size
      FROM files WHERE user_id = ?
      GROUP BY file_type
    `).all(userId);
  },
  recent(limit, userId) {
    return db.prepare('SELECT * FROM files WHERE user_id = ? ORDER BY uploaded_at DESC LIMIT ?').all(userId, limit);
  }
};

// ============ 启动种子 ============
const adminUser = seedAdmin();
// 将遗留数据（无 user_id）归属到 admin，保证升级后数据可用
if (adminUser) {
  try {
    db.prepare('UPDATE files SET user_id = ? WHERE user_id IS NULL').run(adminUser.id);
    db.prepare('UPDATE folders SET user_id = ? WHERE user_id IS NULL').run(adminUser.id);
  } catch {}
}

// 迁移旧 settings 表（单用户时代）到管理员账号的 user_configs（升级兼容）
if (adminUser) {
  try {
    const cur = userConfigStore.get(adminUser.id);
    const oldBot = settingsStore.get('bot_token');
    if (oldBot && !cur.bot_token) {
      userConfigStore.set(adminUser.id, {
        bot_token: oldBot,
        channel_id: settingsStore.get('channel_id') || '',
        proxy: settingsStore.get('proxy') || '',
        api_root: settingsStore.get('api_root') || '',
        mtproto_api_id: settingsStore.get('mtproto_api_id') || '',
        mtproto_api_hash: settingsStore.get('mtproto_api_hash') || '',
        bot_username: settingsStore.get('bot_username') || ''
      });
      const oldSession = settingsStore.get('mtproto_session');
      if (oldSession) userConfigStore.setKey(adminUser.id, 'mtproto_session', oldSession);
      console.log('📦 已迁移旧配置（Bot/频道/MTProto）到管理员账号');
    }
  } catch (e) {
    console.warn('⚠️ 旧配置迁移失败:', e.message);
  }
}

module.exports = {
  db, settingsStore, folderStore, fileStore,
  userStore, userConfigStore, sessionStore,
  hashPassword, verifyPassword,
  adminUser
};
