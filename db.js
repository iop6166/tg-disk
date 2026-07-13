const { DatabaseSync } = require('node:sqlite');
const path = require('path');

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
  create(name, parentId) {
    const result = db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId || null);
    return this.getById(result.lastInsertRowid);
  },
  getById(id) {
    return db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  },
  getByParent(parentId) {
    if (parentId === null || parentId === undefined) {
      return db.prepare('SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name').all();
    }
    return db.prepare('SELECT * FROM folders WHERE parent_id = ? ORDER BY name').all(parentId);
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
    const children = this.getByParent(id);
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
      INSERT INTO files (name, original_name, size, mime_type, file_type, file_id, file_unique_id, thumb_file_id, message_id, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.folder_id || null
    );
    return this.getById(result.lastInsertRowid);
  },
  getById(id) {
    return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  },
  getByFolder(folderId) {
    if (folderId === null || folderId === undefined) {
      return db.prepare('SELECT * FROM files WHERE folder_id IS NULL ORDER BY uploaded_at DESC').all();
    }
    return db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY uploaded_at DESC').all(folderId);
  },
  search(query) {
    const pattern = `%${query}%`;
    return db.prepare('SELECT * FROM files WHERE name LIKE ? ORDER BY uploaded_at DESC').all(pattern);
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
  copy(id, folderId) {
    const file = this.getById(id);
    if (!file) return null;
    const result = db.prepare(`
      INSERT INTO files (name, original_name, size, mime_type, file_type, file_id, file_unique_id, thumb_file_id, message_id, folder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      file.name, file.original_name, file.size, file.mime_type,
      file.file_type, file.file_id, file.file_unique_id, file.thumb_file_id,
      file.message_id, folderId || null
    );
    return this.getById(result.lastInsertRowid);
  },
  getByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM files WHERE id IN (${placeholders})`).all(...ids);
  },
  count() {
    return db.prepare('SELECT COUNT(*) as count FROM files').get().count;
  },
  totalSize() {
    const result = db.prepare('SELECT SUM(size) as total FROM files').get();
    return result.total || 0;
  },
  statsByType() {
    return db.prepare(`
      SELECT file_type, COUNT(*) as count, SUM(size) as total_size
      FROM files
      GROUP BY file_type
    `).all();
  },
  recent(limit) {
    return db.prepare('SELECT * FROM files ORDER BY uploaded_at DESC LIMIT ?').all(limit);
  }
};

module.exports = { db, settingsStore, folderStore, fileStore };
