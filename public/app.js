// ============ 全局状态 ============
const state = {
  currentView: 'files',
  currentFolderId: null,
  folderPath: [],
  files: [],
  folders: [],
  searchQuery: '',
  configured: false,
  // MTProto
  mtprotoConnected: false,
  mtprotoUser: null,
  channelFiles: [],
  channelOffset: 0,
  channelHasMore: false,
  channelLoading: false,
  channelSearchQuery: '',
  // 选择与剪贴板
  channelSelectedIds: new Set(),
  channelSelectMode: false,
  channelClipboard: { mode: null, ids: [] },
  fileSelectedIds: new Set(),
  fileSelectMode: false,
  fileClipboard: { mode: null, ids: [] },
  currentUser: null,
};

// ============ 认证 ============
async function checkAuth() {
  try {
    const me = await api('/auth/me');
    state.currentUser = me.user;
    enterApp();
  } catch {
    showAuthScreen();
  }
}

function showAuthScreen() {
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('userBadge').style.display = 'none';
}

function enterApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('app').style.display = '';
  const badge = document.getElementById('userBadge');
  badge.style.display = 'flex';
  document.getElementById('userBadgeName').textContent =
    state.currentUser.username + (state.currentUser.is_admin ? ' (管理员)' : '');
  loadView();
  updateStorageInfo();
}

function showAuthTab(mode) {
  document.getElementById('loginTab').classList.toggle('active', mode === 'login');
  document.getElementById('registerTab').classList.toggle('active', mode === 'register');
  document.getElementById('loginForm').style.display = mode === 'login' ? '' : 'none';
  document.getElementById('registerForm').style.display = mode === 'register' ? '' : 'none';
  document.getElementById('authError').textContent = '';
}

async function login() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  document.getElementById('authError').textContent = '';
  if (!username || !password) {
    document.getElementById('authError').textContent = '请输入用户名和密码';
    return;
  }
  try {
    const me = await api('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    state.currentUser = me.user;
    enterApp();
  } catch (e) {
    document.getElementById('authError').textContent = e.message;
  }
}

async function register() {
  const username = document.getElementById('regUsername').value.trim();
  const password = document.getElementById('regPassword').value.trim();
  document.getElementById('authError').textContent = '';
  if (!username || !password) {
    document.getElementById('authError').textContent = '请输入用户名和密码';
    return;
  }
  try {
    const me = await api('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    state.currentUser = me.user;
    enterApp();
  } catch (e) {
    document.getElementById('authError').textContent = e.message;
  }
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  state.currentUser = null;
  showAuthScreen();
}

// ============ 工具函数 ============
const API = '/api';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

async function api(url, options = {}) {
  const res = await fetch(API + url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
  return d.toLocaleDateString('zh-CN');
}

function getFileIcon(file) {
  if (file.file_type === 'photo') return '🖼️';
  if (file.file_type === 'video') return '🎬';
  if (file.file_type === 'audio') return '🎵';
  const ext = file.name.split('.').pop().toLowerCase();
  const map = {
    pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
    ppt: '📑', pptx: '📑', zip: '🗜️', rar: '🗜️', '7z': '🗜️',
    txt: '📃', md: '📃', json: '📃', js: '📜', ts: '📜',
    py: '🐍', java: '☕', html: '🌐', css: '🎨', exe: '⚙️',
    apk: '📱', dmg: '💿', iso: '💿'
  };
  return map[ext] || '📁';
}

function getFileThumbHtml(file) {
  // 有缩略图的图片和视频显示缩略图
  if (file.thumb_file_id && (file.file_type === 'photo' || file.file_type === 'video')) {
    const playOverlay = file.file_type === 'video' ? '<div class="thumb-play">▶</div>' : '';
    return `<div class="file-thumb"><img src="${API}/thumb/${file.id}" alt="${escapeHtml(file.name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'file-icon\\'>${getFileIcon(file)}</div>'">${playOverlay}</div>`;
  }
  return `<div class="file-icon">${getFileIcon(file)}</div>`;
}

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ============ 视图渲染 ============
async function loadView() {
  const container = document.getElementById('contentContainer');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';

  try {
    if (state.currentView === 'files') await loadFilesView();
    else if (state.currentView === 'channel') await loadChannelView();
    else if (state.currentView === 'recent') await loadRecentView();
    else if (state.currentView === 'stats') await loadStatsView();
    else if (state.currentView === 'settings') await loadSettingsView();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>加载失败</h3><p>${err.message}</p></div>`;
  }
}

async function loadFilesView() {
  const params = state.currentFolderId ? `?folder_id=${state.currentFolderId}` : '';
  const [files, folders] = await Promise.all([
    api(`/files${params}`),
    api(`/folders${params}`)
  ]);

  state.files = files;
  state.folders = folders;

  // 加载面包屑
  await loadBreadcrumb();

  renderFileList();
}

async function loadBreadcrumb() {
  const breadcrumb = document.getElementById('breadcrumb');
  if (!state.currentFolderId) {
    breadcrumb.innerHTML = '<span class="breadcrumb-item" onclick="navigateTo(null)">全部文件</span>';
    return;
  }

  const path = await api(`/folders/path/${state.currentFolderId}`);
  state.folderPath = path;

  let html = '<span class="breadcrumb-item" onclick="navigateTo(null)">全部文件</span>';
  path.forEach((folder, i) => {
    html += '<span class="breadcrumb-sep">/</span>';
    html += `<span class="breadcrumb-item" onclick="navigateTo(${folder.id})">${folder.name}</span>`;
  });
  breadcrumb.innerHTML = html;
}

function renderFileList() {
  const container = document.getElementById('contentContainer');
  const folders = state.folders;
  const files = state.searchQuery ? state.files.filter(f => f.name.toLowerCase().includes(state.searchQuery.toLowerCase())) : state.files;

  if (folders.length === 0 && files.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <h3>暂无文件</h3>
        <p>点击上方"上传文件"按钮或拖拽文件到此处开始上传</p>
      </div>
    `;
    return;
  }

  const hasSelection = state.fileSelectedIds.size > 0;
  const hasClipboard = state.fileClipboard.ids.length > 0;

  let html = '';

  // 工具栏
  html += '<div class="clipboard-toolbar">';
  if (hasSelection) {
    html += `<span class="toolbar-info">已选 ${state.fileSelectedIds.size} 项</span>`;
    if (state.currentFolderId !== null) {
      html += `<button class="btn btn-secondary btn-sm" onclick="fileCopy()">复制</button>`;
      html += `<button class="btn btn-secondary btn-sm" onclick="fileCut()">剪切</button>`;
    } else {
      html += `<button class="btn btn-secondary btn-sm" onclick="fileCopy()">复制</button>`;
      html += `<button class="btn btn-secondary btn-sm" onclick="fileCut()">剪切</button>`;
    }
    html += `<button class="btn btn-danger btn-sm" onclick="fileDeleteSelected()">删除选中</button>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="fileClearSelection()">取消选择</button>`;
  } else if (hasClipboard) {
    const modeText = state.fileClipboard.mode === 'cut' ? '剪切' : '复制';
    const canPaste = state.fileClipboard.sourceFolderId !== state.currentFolderId || state.fileClipboard.mode === 'copy';
    html += `<span class="toolbar-info">剪贴板: ${modeText} ${state.fileClipboard.ids.length} 项</span>`;
    if (canPaste) {
      html += `<button class="btn btn-primary btn-sm" onclick="filePaste()">粘贴到此</button>`;
    }
    html += `<button class="btn btn-secondary btn-sm" onclick="fileClearClipboard()">清空剪贴板</button>`;
  } else {
    html += `<span class="toolbar-info">${folders.length + files.length} 项</span>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="fileToggleSelectMode()">选择文件</button>`;
  }
  html += '</div>';

  html += '<div class="file-grid">';

  // 文件夹
  if (!state.searchQuery) {
    for (const folder of folders) {
      const safeName = escapeHtml(folder.name);
      html += `
        <div class="file-card folder-card" onclick="navigateTo(${folder.id})">
          <div class="file-actions">
            <div class="file-action-btn" onclick="event.stopPropagation();renameFolder(${folder.id})" title="重命名">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </div>
            <div class="file-action-btn danger" onclick="event.stopPropagation();deleteFolder(${folder.id})" title="删除">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </div>
          </div>
          <div class="file-icon">📁</div>
          <div class="file-name">${safeName}</div>
          <div class="file-meta">${formatDate(folder.created_at)}</div>
        </div>
      `;
    }
  }

  // 文件
  for (const file of files) {
    const safeName = escapeHtml(file.name);
    const isSelected = state.fileSelectedIds.has(file.id);
    const selectCheckbox = hasSelection || state.fileSelectMode
      ? `<div class="file-select ${isSelected ? 'selected' : ''}" onclick="event.stopPropagation();fileToggleSelect(${file.id})">${isSelected ? '✓' : ''}</div>`
      : '';

    html += `
      <div class="file-card ${isSelected ? 'card-selected' : ''}" onclick="${hasSelection || state.fileSelectMode ? `fileToggleSelect(${file.id})` : `previewFile(${file.id})`}">
        ${selectCheckbox}
        <div class="file-actions">
          <div class="file-action-btn" onclick="event.stopPropagation();downloadFile(${file.id})" title="下载">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="file-action-btn" onclick="event.stopPropagation();renameFile(${file.id})" title="重命名">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div class="file-action-btn danger" onclick="event.stopPropagation();deleteFile(${file.id})" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
        ${getFileThumbHtml(file)}
        <div class="file-name">${safeName}</div>
        <div class="file-meta">${formatSize(file.size)} · ${formatDate(file.uploaded_at)}</div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;
}

async function loadRecentView() {
  const stats = await api('/stats');
  const files = stats.recent_files || [];

  const container = document.getElementById('contentContainer');

  if (files.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🕐</div><h3>暂无最近文件</h3><p>上传文件后将显示在这里</p></div>';
    return;
  }

  let html = '<div class="file-grid">';
  for (const file of files) {
    const safeName = escapeHtml(file.name);
    html += `
      <div class="file-card" onclick="previewFile(${file.id})">
        <div class="file-actions">
          <div class="file-action-btn" onclick="event.stopPropagation();downloadFile(${file.id})" title="下载">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="file-action-btn danger" onclick="event.stopPropagation();deleteFile(${file.id})" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
        ${getFileThumbHtml(file)}
        <div class="file-name">${safeName}</div>
        <div class="file-meta">${formatSize(file.size)} · ${formatDate(file.uploaded_at)}</div>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

async function loadStatsView() {
  const stats = await api('/stats');
  const container = document.getElementById('contentContainer');

  const typeIcons = { photo: '🖼️', video: '🎬', audio: '🎵', document: '📄' };
  const typeColors = { photo: '#8b5cf6', video: '#ef4444', audio: '#10b981', document: '#3b82f6' };

  const maxCount = Math.max(...(stats.by_type || []).map(t => t.count), 1);

  let typeHtml = '';
  for (const t of (stats.by_type || [])) {
    const pct = (t.count / maxCount) * 100;
    const color = typeColors[t.file_type] || '#6b7280';
    typeHtml += `
      <div class="type-bar">
        <div class="type-bar-icon">${typeIcons[t.file_type] || '📁'}</div>
        <div class="type-bar-label">${t.file_type}</div>
        <div class="type-bar-track">
          <div class="type-bar-fill" style="width: ${pct}%; background: ${color}"></div>
        </div>
        <div class="type-bar-count">${t.count} 个</div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="stats-page">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📦</div>
          <div class="stat-label">文件总数</div>
          <div class="stat-value">${stats.file_count || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💾</div>
          <div class="stat-label">已用空间</div>
          <div class="stat-value">${formatSize(stats.total_size || 0)}</div>
        </div>
      </div>

      <div class="type-breakdown">
        <h3>文件类型分布</h3>
        ${typeHtml || '<p style="color:var(--text-muted);font-size:13px">暂无数据</p>'}
      </div>

      ${stats.recent_files && stats.recent_files.length > 0 ? `
        <div class="type-breakdown" style="margin-top:16px">
          <h3>最近上传</h3>
          ${stats.recent_files.map(f => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
              <span style="font-size:20px">${getFileIcon(f)}</span>
              <div style="flex:1">
                <div style="font-size:13px;font-weight:500">${f.name}</div>
                <div style="font-size:11px;color:var(--text-muted)">${formatSize(f.size)} · ${formatDate(f.uploaded_at)}</div>
              </div>
              <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px" onclick="downloadFile(${f.id})">下载</button>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

async function loadSettingsView() {
  const settings = await api('/user/config');
  state.configured = settings.configured;
  const container = document.getElementById('contentContainer');
  // 隐藏拖拽区
  document.getElementById('dropZone').style.display = 'none';
  container.innerHTML = `
    <div class="settings-page">
      <div class="settings-section">
        <h3>Telegram 配置</h3>
        <div style="margin-bottom:16px">
          <span class="status-badge ${settings.configured ? 'connected' : 'disconnected'}">
            ${settings.configured ? '✅ 已配置' : '❌ 未配置'}
          </span>
          ${settings.bot_username ? `<span style="font-size:13px;color:var(--text-muted);margin-left:8px">@${settings.bot_username}</span>` : ''}
        </div>

        <div class="form-group">
          <label>Bot Token</label>
          <input type="text" id="botTokenInput" placeholder="从 @BotFather 获取的 Bot Token" value="${settings.bot_token_masked || ''}">
          <div class="hint">在 Telegram 中搜索 @BotFather，发送 /newbot 创建机器人</div>
        </div>

        <div class="form-group">
          <label>频道 ID</label>
          <input type="text" id="channelIdInput" placeholder="例如: -1001234567890" value="${settings.channel_id || ''}">
          <div class="hint">创建私有频道，将机器人添加为管理员，频道 ID 可通过 @userinfobot 获取</div>
        </div>

        <div class="form-group">
          <label>代理地址（可选）</label>
          <input type="text" id="proxyInput" placeholder="例如: http://127.0.0.1:7890 或 socks5://127.0.0.1:1080" value="${settings.proxy || ''}">
          <div class="hint">中国大陆需配置代理才能访问 Telegram。支持 HTTP 和 SOCKS5 代理</div>
        </div>

        <div class="form-group">
          <label>自定义 API 地址（可选）</label>
          <input type="text" id="apiRootInput" placeholder="例如: https://your-proxy.example.com" value="${settings.api_root || ''}">
          <div class="hint">如果你有 api.telegram.org 的反向代理地址，可填入此处</div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="saveSettings(false)">保存并验证</button>
          <button class="btn" onclick="saveSettings(true)" style="background:#fff3cd;border:1px solid #ffeaa7;color:#856404">跳过验证直接保存</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>使用说明</h3>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.8">
          <p>1. 在 Telegram 中找 <strong>@BotFather</strong>，发送 <code>/newbot</code> 创建一个新机器人，获取 Bot Token</p>
          <p>2. 创建一个<strong>私有频道</strong>（Private Channel）</p>
          <p>3. 将机器人添加为频道<strong>管理员</strong>，授予发送消息和删除消息权限</p>
          <p>4. 获取频道 ID：将频道消息转发给 <strong>@userinfobot</strong>，或使用 Telegram API</p>
          <p>5. <strong>中国大陆用户</strong>：必须填写代理地址（如 Clash 默认 <code>http://127.0.0.1:7890</code>）</p>
          <p>6. 在上方填入配置，点击「保存并验证」；如验证失败可点击「跳过验证直接保存」</p>
          <p>7. 开始上传文件！文件将存储在 Telegram 频道中，享受无限存储空间</p>
        </div>
        <div style="margin-top:16px;padding:12px;background:#fff3cd;border:1px solid #ffeaa7;border-radius:6px;font-size:12px;color:#856404">
          ⚠️ 注意：Bot API 单文件上传限制为 <strong>50MB</strong>。如需上传更大文件，需运行本地 Bot API Server。
        </div>
        <div style="margin-top:8px;padding:12px;background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;font-size:12px;color:#1565c0">
          💡 提示：「跳过验证直接保存」适用于服务器无法直连 Telegram 但你有代理客户端在本地运行的情况。保存后上传/下载操作会通过代理进行。
        </div>
      </div>

      <div class="settings-section">
        <h3>MTProto 配置（频道浏览）</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">使用手机号登录 Telegram，可浏览频道内所有文件（包括非本系统上传的），支持 4GB 大文件</p>
        <div class="form-group">
          <label>API ID</label>
          <input type="text" id="mtprotoApiIdInput" placeholder="从 my.telegram.org 获取" value="${settings.mtproto_api_id || ''}">
          <div class="hint">访问 my.telegram.org → API development tools → 创建 App 获取</div>
        </div>
        <div class="form-group">
          <label>API Hash</label>
          <input type="text" id="mtprotoApiHashInput" placeholder="从 my.telegram.org 获取" value="${settings.mtproto_api_hash || ''}">
        </div>
        <button class="btn btn-primary" onclick="saveMtprotoConfig()">保存 API 配置</button>
        <div id="mtprotoStatusBox" style="margin-top:16px">
          <div style="padding:12px;background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;font-size:13px;color:#e65100">检查中...</div>
        </div>
      </div>

      <div class="settings-section">
        <h3>账号安全</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">首次登录后请尽快修改默认密码（默认管理员账号为 admin）</p>
        <div class="form-group">
          <label>原密码</label>
          <input type="password" id="oldPasswordInput" placeholder="当前密码">
        </div>
        <div class="form-group">
          <label>新密码</label>
          <input type="password" id="newPasswordInput" placeholder="至少 6 位">
        </div>
        <button class="btn btn-primary" onclick="changePassword()">保存新密码</button>
        <span id="changePwMsg" style="margin-left:10px;font-size:13px"></span>
      </div>

      <div class="settings-section" id="systemSettingsSection">
        <h3>系统设置</h3>
        <div class="autostart-row" id="autostartRow">
          <div class="autostart-info">
            <div class="autostart-label">开机自启动</div>
            <div class="autostart-desc">开启后，电脑开机时自动启动 Telegram 云盘服务（含崩溃自动重启）</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="autostartToggle" onchange="toggleAutostart(this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div id="autostartStatus" style="margin-top:8px;font-size:12px;color:var(--text-muted)">检查中...</div>
      </div>
    </div>
  `;
  // 异步加载 MTProto 状态
  loadMtprotoStatus();
  // 异步加载自启动状态
  loadAutostartStatus();
  // 非管理员隐藏「系统设置」（开机自启动仅管理员可用）
  if (!state.currentUser || !state.currentUser.is_admin) {
    const sysSec = document.getElementById('systemSettingsSection');
    if (sysSec) sysSec.style.display = 'none';
  }
}

async function changePassword() {
  const oldP = document.getElementById('oldPasswordInput');
  const newP = document.getElementById('newPasswordInput');
  const msg = document.getElementById('changePwMsg');
  if (!oldP || !newP) return;
  msg.textContent = '';
  msg.style.color = 'var(--text-muted)';
  try {
    await api('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldP.value, newPassword: newP.value })
    });
    msg.textContent = '✅ 密码已更新';
    msg.style.color = '#2e7d32';
    oldP.value = '';
    newP.value = '';
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.style.color = '#c62828';
  }
}

// ============ MTProto 频道浏览 ============
async function checkMtprotoStatus() {
  try {
    const data = await api('/user/mtproto/status');
    state.mtprotoConnected = data.connected;
    state.mtprotoUser = data.user;
    return data;
  } catch {
    return { connected: false, logged_in: false, has_api: false };
  }
}

async function loadChannelView() {
  const container = document.getElementById('contentContainer');
  const breadcrumb = document.getElementById('breadcrumb');
  breadcrumb.innerHTML = '<span class="breadcrumb-item">频道浏览</span>';

  // 隐藏上传区和文件夹按钮
  document.getElementById('dropZone').style.display = 'none';

  container.innerHTML = '<div class="loading"><div class="spinner"></div>检查登录状态...</div>';

  const status = await checkMtprotoStatus();

  if (!status.has_api) {
    // 需要先配置 API ID/Hash
    container.innerHTML = `
      <div class="empty-state" style="padding:40px">
        <div class="empty-icon">🔑</div>
        <h3>需要配置 Telegram API</h3>
        <p style="margin-bottom:20px">频道浏览功能使用 MTProto API，需要先获取 API ID 和 API Hash</p>
        <div style="text-align:left;max-width:500px;margin:0 auto;font-size:13px;color:var(--text-secondary);line-height:1.8">
          <p><strong>获取步骤：</strong></p>
          <p>1. 访问 <a href="https://my.telegram.org" target="_blank" style="color:var(--primary)">my.telegram.org</a>（需代理）</p>
          <p>2. 登录后点击 "API development tools"</p>
          <p>3. 创建一个 App，获取 <code>api_id</code> 和 <code>api_hash</code></p>
          <p>4. 在下方填入并继续</p>
        </div>
        <div style="margin-top:20px;display:flex;gap:8px;flex-direction:column;max-width:400px;margin-left:auto;margin-right:auto">
          <input type="text" id="mtprotoApiId" placeholder="API ID (数字)" style="padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px">
          <input type="text" id="mtprotoApiHash" placeholder="API Hash" style="padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px">
          <button class="btn btn-primary" onclick="saveMtprotoConfigAndLogin()">保存并登录</button>
        </div>
      </div>
    `;
    return;
  }

  if (!status.logged_in) {
    // 需要登录
    showMtprotoLoginModal();
    container.innerHTML = `
      <div class="empty-state" style="padding:40px">
        <div class="empty-icon">🔐</div>
        <h3>需要登录 Telegram</h3>
        <p>频道浏览需要用手机号登录 Telegram 账号</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="showMtprotoLoginModal()">开始登录</button>
      </div>
    `;
    return;
  }

  // 已登录，加载频道文件
  state.channelFiles = [];
  state.channelOffset = 0;
  await loadChannelFiles();
}

async function loadChannelFiles() {
  if (state.channelLoading) return;
  state.channelLoading = true;

  const container = document.getElementById('contentContainer');

  if (state.channelFiles.length === 0) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div>加载频道文件...</div>';
  }

  try {
    let result;
    if (state.channelSearchQuery) {
      result = await api(`/user/mtproto/channel/search?q=${encodeURIComponent(state.channelSearchQuery)}&offset=${state.channelOffset}`);
    } else {
      result = await api(`/user/mtproto/channel/files?offset=${state.channelOffset}`);
    }

    state.channelFiles = state.channelOffset === 0 ? result.files : [...state.channelFiles, ...result.files];
    state.channelHasMore = result.hasMore;
    state.channelOffset = result.nextOffset || 0;

    renderChannelFiles();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>加载失败</h3><p>${escapeHtml(err.message)}</p><button class="btn btn-primary" style="margin-top:16px" onclick="loadChannelView()">重试</button></div>`;
  } finally {
    state.channelLoading = false;
  }
}

function renderChannelFiles() {
  const container = document.getElementById('contentContainer');
  const files = state.channelFiles;

  if (files.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📂</div>
        <h3>频道内暂无文件</h3>
        <p>${state.channelSearchQuery ? '未找到匹配的文件' : '频道中还没有任何文件'}</p>
      </div>
    `;
    return;
  }

  const hasSelection = state.channelSelectedIds.size > 0;
  const hasClipboard = state.channelClipboard.ids.length > 0;

  let html = '';

  // 工具栏
  html += '<div class="clipboard-toolbar">';
  if (hasSelection) {
    html += `<span class="toolbar-info">已选 ${state.channelSelectedIds.size} 项</span>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="channelCopy()">复制</button>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="channelCut()">剪切</button>`;
    html += `<button class="btn btn-danger btn-sm" onclick="channelDeleteSelected()">删除选中</button>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="channelClearSelection()">取消选择</button>`;
  } else if (hasClipboard) {
    const modeText = state.channelClipboard.mode === 'cut' ? '剪切' : '复制';
    html += `<span class="toolbar-info">剪贴板: ${modeText} ${state.channelClipboard.ids.length} 项</span>`;
    html += `<button class="btn btn-primary btn-sm" onclick="channelPaste()">粘贴到此</button>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="channelClearClipboard()">清空剪贴板</button>`;
  } else {
    html += `<span class="toolbar-info">${files.length} 个文件</span>`;
    html += `<button class="btn btn-secondary btn-sm" onclick="channelToggleSelectMode()">选择文件</button>`;
  }
  html += '</div>';

  html += '<div class="file-grid">';

  for (const file of files) {
    const safeName = escapeHtml(file.name);
    const date = file.date ? new Date(file.date * 1000).toLocaleDateString('zh-CN') : '';
    const isSelected = state.channelSelectedIds.has(file.message_id);

    let thumbHtml = '';
    if (file.has_thumb) {
      const playOverlay = file.file_type === 'video' ? '<div class="thumb-play">▶</div>' : '';
      thumbHtml = `<div class="file-thumb"><img src="${API}/user/mtproto/channel/thumb/${file.message_id}" alt="${safeName}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'file-icon\\'>${getFileIcon(file)}</div>'">${playOverlay}</div>`;
    } else {
      thumbHtml = `<div class="file-icon">${getFileIcon(file)}</div>`;
    }

    const selectCheckbox = hasSelection || state.channelSelectMode
      ? `<div class="file-select ${isSelected ? 'selected' : ''}" onclick="event.stopPropagation();channelToggleSelect(${file.message_id})">${isSelected ? '✓' : ''}</div>`
      : '';

    html += `
      <div class="file-card ${isSelected ? 'card-selected' : ''}" onclick="${hasSelection || state.channelSelectMode ? `channelToggleSelect(${file.message_id})` : `previewChannelFile(${file.message_id})`}">
        ${selectCheckbox}
        <div class="file-actions">
          <div class="file-action-btn" onclick="event.stopPropagation();downloadChannelFile(${file.message_id})" title="下载">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="file-action-btn" onclick="event.stopPropagation();renameChannelFile(${file.message_id})" title="重命名">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </div>
          <div class="file-action-btn danger" onclick="event.stopPropagation();deleteChannelFile(${file.message_id})" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </div>
        </div>
        ${thumbHtml}
        <div class="file-name">${safeName}</div>
        <div class="file-meta">${formatSize(file.size)} · ${date}</div>
      </div>
    `;
  }

  html += '</div>';

  // 加载更多按钮
  if (state.channelHasMore) {
    html += `<div style="text-align:center;padding:20px"><button class="btn btn-secondary" onclick="loadMoreChannelFiles()">加载更多</button></div>`;
  }

  container.innerHTML = html;
}

async function loadMoreChannelFiles() {
  await loadChannelFiles();
}

async function downloadChannelFile(messageId) {
  const file = state.channelFiles.find(f => f.message_id === messageId);
  const mime = file ? encodeURIComponent(file.mime_type || '') : '';
  const name = file ? encodeURIComponent(file.name || '') : '';
  toast('开始下载...', 'info');
  window.location.href = `${API}/user/mtproto/channel/download/${messageId}?mime=${mime}&name=${name}`;
}

// ============ 频道文件管理 ============

async function deleteChannelFile(messageId) {
  const file = state.channelFiles.find(f => f.message_id === messageId);
  const name = file ? file.name : '此文件';
  if (!confirm(`确定删除「${name}」？此操作不可恢复。`)) return;
  try {
    await api(`/user/mtproto/channel/files/${messageId}`, { method: 'DELETE' });
    toast('文件已删除', 'success');
    // 从列表中移除
    state.channelFiles = state.channelFiles.filter(f => f.message_id !== messageId);
    renderChannelFiles();
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

async function renameChannelFile(messageId) {
  const file = state.channelFiles.find(f => f.message_id === messageId);
  if (!file) return;
  const newName = prompt('输入新名称:', file.name);
  if (!newName || newName === file.name) return;
  try {
    await api(`/user/mtproto/channel/files/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    file.name = newName;
    toast('已重命名', 'success');
    renderChannelFiles();
  } catch (err) {
    toast('重命名失败: ' + err.message, 'error');
  }
}

// 选择模式
function channelToggleSelectMode() {
  state.channelSelectMode = !state.channelSelectMode;
  if (!state.channelSelectMode) {
    state.channelSelectedIds.clear();
  }
  renderChannelFiles();
}

function channelToggleSelect(messageId) {
  if (state.channelSelectedIds.has(messageId)) {
    state.channelSelectedIds.delete(messageId);
  } else {
    state.channelSelectedIds.add(messageId);
  }
  if (state.channelSelectedIds.size === 0) {
    state.channelSelectMode = false;
  }
  renderChannelFiles();
}

function channelClearSelection() {
  state.channelSelectedIds.clear();
  state.channelSelectMode = false;
  renderChannelFiles();
}

// 复制
function channelCopy() {
  state.channelClipboard = { mode: 'copy', ids: [...state.channelSelectedIds] };
  state.channelSelectedIds.clear();
  state.channelSelectMode = false;
  toast(`已复制 ${state.channelClipboard.ids.length} 项到剪贴板`, 'success');
  renderChannelFiles();
}

// 剪切
function channelCut() {
  state.channelClipboard = { mode: 'cut', ids: [...state.channelSelectedIds] };
  state.channelSelectedIds.clear();
  state.channelSelectMode = false;
  toast(`已剪切 ${state.channelClipboard.ids.length} 项到剪贴板`, 'success');
  renderChannelFiles();
}

// 粘贴
async function channelPaste() {
  if (state.channelClipboard.ids.length === 0) return;
  const modeText = state.channelClipboard.mode === 'cut' ? '剪切' : '复制';
  if (!confirm(`确定${modeText}粘贴 ${state.channelClipboard.ids.length} 个文件？`)) return;

  try {
    await api('/user/mtproto/channel/forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_ids: state.channelClipboard.ids,
        delete_original: state.channelClipboard.mode === 'cut'
      })
    });
    toast(`已${modeText}粘贴 ${state.channelClipboard.ids.length} 个文件`, 'success');
    state.channelClipboard = { mode: null, ids: [] };
    // 重新加载频道文件
    state.channelFiles = [];
    state.channelOffset = 0;
    await loadChannelFiles();
  } catch (err) {
    toast('粘贴失败: ' + err.message, 'error');
  }
}

function channelClearClipboard() {
  state.channelClipboard = { mode: null, ids: [] };
  renderChannelFiles();
}

// 批量删除选中
async function channelDeleteSelected() {
  const count = state.channelSelectedIds.size;
  if (count === 0) return;
  if (!confirm(`确定删除选中的 ${count} 个文件？此操作不可恢复。`)) return;

  try {
    for (const messageId of state.channelSelectedIds) {
      try {
        await api(`/user/mtproto/channel/files/${messageId}`, { method: 'DELETE' });
      } catch (err) {
        console.warn('删除失败:', messageId, err.message);
      }
    }
    toast(`已删除 ${count} 个文件`, 'success');
    state.channelFiles = state.channelFiles.filter(f => !state.channelSelectedIds.has(f.message_id));
    state.channelSelectedIds.clear();
    state.channelSelectMode = false;
    renderChannelFiles();
  } catch (err) {
    toast('批量删除失败: ' + err.message, 'error');
  }
}

async function previewChannelFile(messageId) {
  const modal = document.getElementById('previewModal');
  const content = document.getElementById('previewContent');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>加载预览...</div>';
  modal.classList.add('active');

  // 从 state 中找到文件信息
  const file = state.channelFiles.find(f => f.message_id === messageId);
  if (!file) {
    content.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><h3>文件信息不存在</h3></div>';
    return;
  }

  const mime = encodeURIComponent(file.mime_type || '');
  const previewUrl = `${API}/user/mtproto/channel/preview/${messageId}?mime=${mime}`;
  // 视频和音频使用 stream 端点（支持 Range 请求，可拖动播放）
  const streamUrl = `${API}/user/mtproto/channel/stream/${messageId}?mime=${mime}`;
  let html = '';

  if (file.file_type === 'photo') {
    html = `<img src="${previewUrl}" alt="${escapeHtml(file.name)}">`;
  } else   if (file.file_type === 'video') {
    const sizeStr = formatSize(file.size);
    html = `<div style="position:relative">
      <video src="${streamUrl}" controls playsinline webkit-playsinline preload="metadata"
        id="previewVideo"
        onwaiting="showVideoLoading()"
        onplaying="hideVideoLoading()"
        oncanplay="hideVideoLoading()"
        onerror="onVideoError(${messageId}, '${escapeHtml(file.name).replace(/'/g, "\\'")}', ${file.size})">
      </video>
      <div id="videoLoading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);color:#fff;font-size:14px;flex-direction:column;gap:8px">
        <div class="spinner" style="border-color:rgba(255,255,255,0.3);border-top-color:#fff"></div>
        <span>正在准备视频 (${sizeStr})...</span>
        <button class="btn btn-secondary" onclick="onVideoError(${messageId}, '${escapeHtml(file.name).replace(/'/g, "\\'")}', ${file.size})" style="margin-top:8px;padding:4px 12px;font-size:12px">加载慢？点击下载</button>
      </div>
    </div>`;
  } else if (file.file_type === 'audio') {
    html = `<div style="padding:40px;text-align:center;background:#f5f5f5"><div style="font-size:64px">🎵</div></div><audio src="${streamUrl}" controls preload="metadata"></audio>`;
  } else if (file.mime_type && file.mime_type.startsWith('image/')) {
    html = `<img src="${previewUrl}" alt="${escapeHtml(file.name)}">`;
  } else if (file.mime_type && file.mime_type.startsWith('video/')) {
    const sizeStr = formatSize(file.size);
    html = `<div style="position:relative">
      <video src="${streamUrl}" controls playsinline webkit-playsinline preload="metadata"
        id="previewVideo"
        onwaiting="showVideoLoading()"
        onplaying="hideVideoLoading()"
        oncanplay="hideVideoLoading()"
        onerror="onVideoError(${messageId}, '${escapeHtml(file.name).replace(/'/g, "\\'")}', ${file.size})">
      </video>
      <div id="videoLoading" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);color:#fff;font-size:14px;flex-direction:column;gap:8px">
        <div class="spinner" style="border-color:rgba(255,255,255,0.3);border-top-color:#fff"></div>
        <span>正在准备视频 (${sizeStr})...</span>
        <button class="btn btn-secondary" onclick="onVideoError(${messageId}, '${escapeHtml(file.name).replace(/'/g, "\\'")}', ${file.size})" style="margin-top:8px;padding:4px 12px;font-size:12px">加载慢？点击下载</button>
      </div>
    </div>`;
  } else if (file.mime_type && file.mime_type.startsWith('audio/')) {
    html = `<div style="padding:40px;text-align:center;background:#f5f5f5"><div style="font-size:64px">🎵</div></div><audio src="${streamUrl}" controls preload="metadata"></audio>`;
  } else if (file.mime_type === 'application/pdf') {
    html = `<iframe src="${previewUrl}" style="width:100%;height:80vh;border:none"></iframe>`;
  } else if (file.mime_type && file.mime_type.startsWith('text/')) {
    html = `<iframe src="${previewUrl}" style="width:100%;height:80vh;border:none"></iframe>`;
  } else {
    html = `<div class="empty-state" style="padding:60px"><div class="empty-icon">📄</div><h3>不支持预览此文件类型</h3><p>${escapeHtml(file.name)}</p><button class="btn btn-primary" style="margin-top:16px" onclick="downloadChannelFile(${messageId})">下载文件</button></div>`;
  }

  html += `<div class="preview-info"><span class="preview-info-name">${escapeHtml(file.name)}</span><div style="display:flex;gap:8px"><button class="btn btn-secondary" onclick="renameChannelFile(${messageId})">重命名</button><button class="btn btn-danger" onclick="deleteChannelFile(${messageId})">删除</button><button class="btn btn-primary" onclick="downloadChannelFile(${messageId})">下载</button></div></div>`;
  content.innerHTML = html;
}

// ============ MTProto 登录流程 ============
async function saveMtprotoConfig() {
  const apiId = document.getElementById('mtprotoApiIdInput').value.trim();
  const apiHash = document.getElementById('mtprotoApiHashInput').value.trim();

  if (!apiId || !apiHash) {
    toast('请填写 API ID 和 API Hash', 'warning');
    return;
  }

  try {
    await api('/user/mtproto/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
    });
    toast('API 配置已保存', 'success');
    loadMtprotoStatus();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

async function loadMtprotoStatus() {
  const box = document.getElementById('mtprotoStatusBox');
  if (!box) return;
  try {
    const status = await api('/user/mtproto/status');
    if (status.logged_in && status.user) {
      const name = [status.user.firstName, status.user.lastName].filter(Boolean).join(' ');
      box.innerHTML = `
        <div style="padding:12px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div>
              <span style="font-size:14px;font-weight:500">已登录: ${escapeHtml(name)}</span>
              ${status.user.username ? `<span style="font-size:12px;color:var(--text-muted);margin-left:8px">@${escapeHtml(status.user.username)}</span>` : ''}
            </div>
            <button class="btn btn-secondary" style="font-size:12px;padding:4px 12px" onclick="mtprotoLogout()">退出登录</button>
          </div>
        </div>
      `;
    } else if (status.has_api) {
      box.innerHTML = `
        <div style="padding:12px;background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;font-size:13px;color:#e65100">
          API 已配置，但未登录。请到「频道浏览」页面进行手机号登录
        </div>
      `;
    } else {
      box.innerHTML = `
        <div style="padding:12px;background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;font-size:13px;color:#e65100">
          未配置。请填写 API ID 和 API Hash
        </div>
      `;
    }
  } catch {
    box.innerHTML = '<div style="padding:12px;background:#ffebee;border:1px solid #ef9a9a;border-radius:6px;font-size:13px;color:#c62828">状态检查失败</div>';
  }
}

async function saveMtprotoConfigAndLogin() {
  const apiId = document.getElementById('mtprotoApiId').value.trim();
  const apiHash = document.getElementById('mtprotoApiHash').value.trim();

  if (!apiId || !apiHash) {
    toast('请填写 API ID 和 API Hash', 'warning');
    return;
  }

  try {
    await api('/user/mtproto/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
    });
    toast('API 配置已保存', 'success');
    showMtprotoLoginModal();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

function showMtprotoLoginModal() {
  const modal = document.getElementById('mtprotoLoginModal');
  const content = document.getElementById('mtprotoLoginContent');
  modal.classList.add('active');

  content.innerHTML = `
    <h3 style="margin-bottom:16px">Telegram 登录</h3>
    <div class="form-group">
      <label>手机号</label>
      <input type="text" id="mtprotoPhone" placeholder="+8613800138000" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px;box-sizing:border-box">
      <div class="hint">包含国际区号，如 +86 开头。验证码会发送到 Telegram 已登录设备，或通过短信发送</div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-secondary" onclick="closeMtprotoLogin()">取消</button>
      <button class="btn btn-primary" onclick="sendMtprotoCode()">发送验证码</button>
    </div>
    <div style="margin-top:16px;padding:10px;background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;font-size:12px;color:#1565c0">
      💡 +86 号码收不到短信？如果你已在其他设备登录 Telegram，验证码会直接发到 Telegram 应用内（不是短信）
    </div>
  `;
}

function closeMtprotoLogin() {
  document.getElementById('mtprotoLoginModal').classList.remove('active');
}

async function sendMtprotoCode() {
  const phone = document.getElementById('mtprotoPhone').value.trim();
  if (!phone) return toast('请输入手机号', 'warning');

  const content = document.getElementById('mtprotoLoginContent');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>发送验证码中...</div>';

  try {
    await api('/user/mtproto/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone_number: phone })
    });

    content.innerHTML = `
      <h3 style="margin-bottom:16px">输入验证码</h3>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">验证码已发送到 ${escapeHtml(phone)}</p>
      <div class="form-group">
        <input type="text" inputmode="numeric" pattern="[0-9]*" id="mtprotoCode" placeholder="输入6位验证码" maxlength="6" style="width:100%;padding:12px;border:1px solid var(--border);border-radius:6px;font-size:24px;text-align:center;letter-spacing:8px;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn btn-secondary" onclick="showMtprotoLoginModal()">返回</button>
        <button class="btn btn-primary" onclick="verifyMtprotoCode()">验证</button>
      </div>
    `;
    setTimeout(() => document.getElementById('mtprotoCode')?.focus(), 100);
  } catch (err) {
    content.innerHTML = `
      <h3 style="margin-bottom:16px">发送失败</h3>
      <p style="color:var(--danger);margin-bottom:16px">${escapeHtml(err.message)}</p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="closeMtprotoLogin()">关闭</button>
        <button class="btn btn-primary" onclick="showMtprotoLoginModal()">重试</button>
      </div>
    `;
  }
}

async function verifyMtprotoCode() {
  const code = document.getElementById('mtprotoCode').value.trim();
  if (!code) return toast('请输入验证码', 'warning');

  const content = document.getElementById('mtprotoLoginContent');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>验证中...</div>';

  try {
    const result = await api('/user/mtproto/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });

    if (result.success) {
      toast('登录成功！', 'success');
      closeMtprotoLogin();
      state.mtprotoConnected = true;
      state.mtprotoUser = result.user;
      loadChannelView();
    } else if (result.needs2FA) {
      content.innerHTML = `
        <h3 style="margin-bottom:16px">两步验证</h3>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">你的账号已开启两步验证，请输入密码</p>
        <div class="form-group">
          <input type="password" id="mtproto2fa" placeholder="两步验证密码" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:14px;box-sizing:border-box">
        </div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-secondary" onclick="closeMtprotoLogin()">取消</button>
          <button class="btn btn-primary" onclick="verifyMtproto2FA()">验证</button>
        </div>
      `;
      setTimeout(() => document.getElementById('mtproto2fa')?.focus(), 100);
    }
  } catch (err) {
    content.innerHTML = `
      <h3 style="margin-bottom:16px">验证失败</h3>
      <p style="color:var(--danger);margin-bottom:16px">${escapeHtml(err.message)}</p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="closeMtprotoLogin()">关闭</button>
        <button class="btn btn-primary" onclick="sendMtprotoCode()">重新发送</button>
      </div>
    `;
  }
}

async function verifyMtproto2FA() {
  const password = document.getElementById('mtproto2fa').value;
  if (!password) return toast('请输入密码', 'warning');

  const content = document.getElementById('mtprotoLoginContent');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>验证中...</div>';

  try {
    const result = await api('/user/mtproto/verify-2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    if (result.success) {
      toast('登录成功！', 'success');
      closeMtprotoLogin();
      state.mtprotoConnected = true;
      state.mtprotoUser = result.user;
      loadChannelView();
    }
  } catch (err) {
    content.innerHTML = `
      <h3 style="margin-bottom:16px">验证失败</h3>
      <p style="color:var(--danger);margin-bottom:16px">${escapeHtml(err.message)}</p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="closeMtprotoLogin()">关闭</button>
        <button class="btn btn-primary" onclick="verifyMtproto2FA()">重试</button>
      </div>
    `;
  }
}

async function mtprotoLogout() {
  if (!confirm('确定退出 Telegram 登录？退出后需重新输入验证码登录。')) return;
  try {
    await api('/user/mtproto/logout', { method: 'POST' });
    toast('已退出登录', 'success');
    state.mtprotoConnected = false;
    state.mtprotoUser = null;
    loadChannelView();
  } catch (err) {
    toast('退出失败: ' + err.message, 'error');
  }
}

// ============ 搜索 ============
async function searchFiles() {
  const container = document.getElementById('contentContainer');
  container.innerHTML = '<div class="loading"><div class="spinner"></div>搜索中...</div>';
  try {
    const files = await api(`/files/search?q=${encodeURIComponent(state.searchQuery)}`);
    state.files = files;
    state.folders = [];
    // 更新面包屑
    document.getElementById('breadcrumb').innerHTML = `<span class="breadcrumb-item">搜索: "${state.searchQuery}"</span>`;
    renderFileList();
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>搜索失败</h3><p>${err.message}</p></div>`;
  }
}

// ============ 导航 ============
function navigateTo(folderId) {
  state.currentFolderId = folderId;
  state.searchQuery = '';
  document.getElementById('searchInput').value = '';
  loadView();
}

function switchView(view) {
  state.currentView = view;
  state.currentFolderId = null;
  state.searchQuery = '';
  state.channelSearchQuery = '';
  state.channelFiles = [];
  state.channelOffset = 0;
  document.getElementById('searchInput').value = '';

  // 更新导航高亮
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navEl) navEl.classList.add('active');

  // 控制拖拽区和上传按钮的显示
  const dropZone = document.getElementById('dropZone');
  if (view === 'files') {
    dropZone.style.display = 'block';
  } else {
    dropZone.style.display = 'none';
  }

  loadView();
}

// ============ 文件操作 ============
async function downloadFile(id) {
  toast('开始下载...', 'info');
  window.location.href = `${API}/download/${id}`;
}

async function previewFile(id) {
  const modal = document.getElementById('previewModal');
  const content = document.getElementById('previewContent');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>加载预览...</div>';
  modal.classList.add('active');

  try {
    // 获取文件信息（类型、名称）
    const file = await api(`/files/${id}`);
    let html = '';
    const previewUrl = `${API}/preview/${id}`;

    if (file.file_type === 'photo') {
      html = `<img src="${previewUrl}" alt="${escapeHtml(file.name)}">`;
    } else if (file.file_type === 'video') {
      html = `<video src="${previewUrl}" controls autoplay></video>`;
    } else if (file.file_type === 'audio') {
      html = `<div style="padding:40px;text-align:center;background:#f5f5f5"><div style="font-size:64px">🎵</div></div><audio src="${previewUrl}" controls autoplay></audio>`;
    } else if (file.mime_type && file.mime_type.startsWith('image/')) {
      html = `<img src="${previewUrl}" alt="${escapeHtml(file.name)}">`;
    } else if (file.mime_type && file.mime_type.startsWith('video/')) {
      html = `<video src="${previewUrl}" controls autoplay></video>`;
    } else if (file.mime_type && file.mime_type.startsWith('audio/')) {
      html = `<div style="padding:40px;text-align:center;background:#f5f5f5"><div style="font-size:64px">🎵</div></div><audio src="${previewUrl}" controls autoplay></audio>`;
    } else if (file.mime_type === 'application/pdf') {
      html = `<iframe src="${previewUrl}" style="width:100%;height:80vh;border:none"></iframe>`;
    } else if (file.mime_type && file.mime_type.startsWith('text/')) {
      html = `<iframe src="${previewUrl}" style="width:100%;height:80vh;border:none"></iframe>`;
    } else {
      html = `<div class="empty-state" style="padding:60px"><div class="empty-icon">📄</div><h3>不支持预览此文件类型</h3><p>${escapeHtml(file.name)}</p><button class="btn btn-primary" style="margin-top:16px" onclick="downloadFile(${id})">下载文件</button></div>`;
    }

    html += `<div class="preview-info"><span class="preview-info-name">${escapeHtml(file.name)}</span><button class="btn btn-primary" onclick="downloadFile(${id})">下载</button></div>`;
    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><h3>预览失败</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

async function deleteFile(id) {
  if (!confirm('确定删除此文件？文件将从 Telegram 和数据库中永久删除。')) return;
  try {
    await api(`/files/${id}`, { method: 'DELETE' });
    toast('文件已删除', 'success');
    loadView();
    updateStorageInfo();
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

// ============ 我的云盘文件选择与剪贴板 ============

function fileToggleSelectMode() {
  state.fileSelectMode = !state.fileSelectMode;
  if (!state.fileSelectMode) {
    state.fileSelectedIds.clear();
  }
  renderFileList();
}

function fileToggleSelect(id) {
  if (state.fileSelectedIds.has(id)) {
    state.fileSelectedIds.delete(id);
  } else {
    state.fileSelectedIds.add(id);
  }
  if (state.fileSelectedIds.size === 0) {
    state.fileSelectMode = false;
  }
  renderFileList();
}

function fileClearSelection() {
  state.fileSelectedIds.clear();
  state.fileSelectMode = false;
  renderFileList();
}

function fileCopy() {
  state.fileClipboard = { mode: 'copy', ids: [...state.fileSelectedIds], sourceFolderId: state.currentFolderId };
  state.fileSelectedIds.clear();
  state.fileSelectMode = false;
  toast(`已复制 ${state.fileClipboard.ids.length} 项到剪贴板`, 'success');
  renderFileList();
}

function fileCut() {
  state.fileClipboard = { mode: 'cut', ids: [...state.fileSelectedIds], sourceFolderId: state.currentFolderId };
  state.fileSelectedIds.clear();
  state.fileSelectMode = false;
  toast(`已剪切 ${state.fileClipboard.ids.length} 项到剪贴板`, 'success');
  renderFileList();
}

async function filePaste() {
  if (state.fileClipboard.ids.length === 0) return;
  const modeText = state.fileClipboard.mode === 'cut' ? '剪切' : '复制';
  const targetFolder = state.currentFolderId || 0;

  try {
    const endpoint = state.fileClipboard.mode === 'cut' ? '/files/move' : '/files/copy';
    await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: state.fileClipboard.ids, folder_id: targetFolder })
    });
    toast(`已${modeText}粘贴 ${state.fileClipboard.ids.length} 个文件`, 'success');
    if (state.fileClipboard.mode === 'cut') {
      state.fileClipboard = { mode: null, ids: [] };
    }
    loadView();
  } catch (err) {
    toast('粘贴失败: ' + err.message, 'error');
  }
}

function fileClearClipboard() {
  state.fileClipboard = { mode: null, ids: [] };
  renderFileList();
}

async function fileDeleteSelected() {
  const count = state.fileSelectedIds.size;
  if (count === 0) return;
  if (!confirm(`确定删除选中的 ${count} 个文件？文件将从 Telegram 和数据库中永久删除。`)) return;

  try {
    for (const id of state.fileSelectedIds) {
      try {
        await api(`/files/${id}`, { method: 'DELETE' });
      } catch (err) {
        console.warn('删除失败:', id, err.message);
      }
    }
    toast(`已删除 ${count} 个文件`, 'success');
    state.fileSelectedIds.clear();
    state.fileSelectMode = false;
    loadView();
    updateStorageInfo();
  } catch (err) {
    toast('批量删除失败: ' + err.message, 'error');
  }
}

// ============ 文件夹操作 ============
function showFolderModal() {
  document.getElementById('folderNameInput').value = '';
  document.getElementById('folderModal').classList.add('active');
  setTimeout(() => document.getElementById('folderNameInput').focus(), 100);
}

async function createFolder() {
  const name = document.getElementById('folderNameInput').value.trim();
  if (!name) return toast('文件夹名称不能为空', 'warning');

  try {
    await api('/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_id: state.currentFolderId })
    });
    document.getElementById('folderModal').classList.remove('active');
    toast('文件夹已创建', 'success');
    loadView();
  } catch (err) {
    toast('创建失败: ' + err.message, 'error');
  }
}

async function deleteFolder(id) {
  if (!confirm('确定删除此文件夹？文件夹内的所有子文件夹和文件引用将被删除（Telegram 上的文件不会删除）。')) return;
  try {
    await api(`/folders/${id}`, { method: 'DELETE' });
    toast('文件夹已删除', 'success');
    loadView();
  } catch (err) {
    toast('删除失败: ' + err.message, 'error');
  }
}

// 重命名
let renameTarget = null;
function showRenameModal(type, id, name) {
  renameTarget = { type, id };
  document.getElementById('renameInput').value = name;
  document.getElementById('renameModal').classList.add('active');
  setTimeout(() => {
    const input = document.getElementById('renameInput');
    input.focus();
    input.select();
  }, 100);
}

function renameFile(id) {
  const file = state.files.find(f => f.id === id);
  showRenameModal('file', id, file ? file.name : '');
}
function renameFolder(id) {
  const folder = state.folders.find(f => f.id === id);
  showRenameModal('folder', id, folder ? folder.name : '');
}

async function confirmRename() {
  const name = document.getElementById('renameInput').value.trim();
  if (!name) return toast('名称不能为空', 'warning');

  const { type, id } = renameTarget;
  try {
    await api(`/${type === 'file' ? 'files' : 'folders'}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    document.getElementById('renameModal').classList.remove('active');
    toast('已重命名', 'success');
    loadView();
  } catch (err) {
    toast('重命名失败: ' + err.message, 'error');
  }
}

// ============ 上传 ============
async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return;

  const progressContainer = document.getElementById('uploadProgressContainer');
  const progressList = document.getElementById('uploadProgressList');
  progressContainer.style.display = 'block';
  progressList.innerHTML = '';

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }
  if (state.currentFolderId) {
    formData.append('folder_id', state.currentFolderId);
  }

  // 创建进度项
  files.forEach((file, i) => {
    const sizeStr = formatSize(file.size);
    const sizeWarning = file.size > 50 * 1024 * 1024 ? ' <span style="color:#e67e22;font-size:11px">⚠️ 超过50MB云端限制</span>' : '';
    progressList.innerHTML += `
      <div class="upload-item" id="upload-item-${i}">
        <div class="upload-item-info">
          <span class="upload-item-name">${escapeHtml(file.name)}</span>
          <span class="upload-item-status">上传中... ${sizeStr}${sizeWarning}</span>
        </div>
        <div class="upload-bar"><div class="upload-bar-fill" style="width:0%"></div></div>
      </div>
    `;
  });

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/upload`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        files.forEach((_, i) => {
          const fill = document.querySelector(`#upload-item-${i} .upload-bar-fill`);
          if (fill) fill.style.width = pct + '%';
        });
      }
    };

    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText);
      let successCount = 0;
      let errorCount = 0;

      if (data.success) {
        data.success.forEach((file, i) => {
          successCount++;
          const item = document.getElementById(`upload-item-${i}`);
          if (item) {
            item.querySelector('.upload-item-status').textContent = '✅ 上传成功';
            item.querySelector('.upload-item-status').classList.add('success');
            item.querySelector('.upload-bar-fill').style.width = '100%';
          }
        });
      }

      if (data.errors) {
        data.errors.forEach(err => {
          errorCount++;
          const items = document.querySelectorAll('.upload-item');
          items.forEach(item => {
            if (item.querySelector('.upload-item-name').textContent === err.file) {
              item.querySelector('.upload-item-status').textContent = `❌ ${err.error}`;
              item.querySelector('.upload-item-status').classList.add('error');
            }
          });
        });
      }

      if (successCount > 0) toast(`${successCount} 个文件上传成功`, 'success');
      if (errorCount > 0) toast(`${errorCount} 个文件上传失败`, 'error');

      loadView();
      updateStorageInfo();
    };

    xhr.onerror = () => {
      toast('上传失败: 网络错误', 'error');
      document.querySelectorAll('.upload-item-status').forEach(el => {
        el.textContent = '❌ 上传失败';
        el.classList.add('error');
      });
    };

    xhr.send(formData);
  } catch (err) {
    toast('上传失败: ' + err.message, 'error');
  }
}

// ============ 开机自启动 ============
async function loadAutostartStatus() {
  try {
    const data = await api('/autostart');
    const toggle = document.getElementById('autostartToggle');
    const status = document.getElementById('autostartStatus');
    if (toggle) toggle.checked = data.enabled;
    if (status) {
      status.innerHTML = data.enabled
        ? '✅ 已启用 — 开机时将自动启动云盘服务'
        : '⬚ 未启用 — 开机后需手动启动';
    }
  } catch {
    const status = document.getElementById('autostartStatus');
    if (status) status.textContent = '⚠️ 无法获取自启动状态（仅支持 Windows）';
  }
}

async function toggleAutostart(enabled) {
  try {
    const resp = await api('/autostart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    toast(resp.message, 'success');
    loadAutostartStatus();
  } catch (err) {
    toast('操作失败: ' + err.message, 'error');
    loadAutostartStatus();
  }
}

// ============ 设置保存 ============
async function saveSettings(forceSave) {
  const token = document.getElementById('botTokenInput').value.trim();
  const channelId = document.getElementById('channelIdInput').value.trim();
  const proxy = document.getElementById('proxyInput').value.trim();
  const apiRoot = document.getElementById('apiRootInput').value.trim();

  const body = { force_save: !!forceSave };
  // 只有当 token 不是掩码值时才提交
  if (token && !token.includes('****')) body.bot_token = token;
  if (channelId) body.channel_id = channelId;
  body.proxy = proxy;
  body.api_root = apiRoot;

  try {
    const resp = await api('/user/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    toast(resp.message || '配置已保存', 'success');
    loadSettingsView();
  } catch (err) {
    toast('保存失败: ' + err.message, 'error');
  }
}

// ============ 存储信息 ============
async function updateStorageInfo() {
  try {
    const stats = await api('/stats');
    const info = document.getElementById('storageInfo');
    const fill = info.querySelector('.storage-fill');
    const text = info.querySelector('.storage-text');

    // Telegram 是无限存储，这里显示已用空间
    const size = formatSize(stats.total_size || 0);
    const count = stats.file_count || 0;
    fill.style.width = count > 0 ? '100%' : '0%';
    text.textContent = `${count} 个文件 · ${size}`;
  } catch {
    // 忽略
  }
}

// ============ 视频播放辅助函数 ============
function showVideoLoading() {
  const el = document.getElementById('videoLoading');
  if (el) el.style.display = 'flex';
}

function hideVideoLoading() {
  const el = document.getElementById('videoLoading');
  if (el) el.style.display = 'none';
}

function onVideoError(messageId, fileName, fileSize) {
  const loadingEl = document.getElementById('videoLoading');
  if (!loadingEl) return;
  loadingEl.style.display = 'flex';
  const sizeStr = formatSize(fileSize);
  // 检测是否手机端（国内网络可能不通）
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const tipText = isMobile
    ? '⚠️ 手机端视频播放需要关闭VPN，或直接下载观看'
    : '⚠️ 视频加载失败，可能网络较慢，请尝试下载';
  loadingEl.innerHTML = `<div style="text-align:center;padding:16px">
    <div style="font-size:32px;margin-bottom:8px">😅</div>
    <div style="color:#ff6b6b;font-size:14px;margin-bottom:12px">${tipText}</div>
    <button class="btn btn-primary" onclick="downloadChannelFile(${messageId})" style="padding:8px 20px;font-size:14px">
      📥 下载文件 (${sizeStr})
    </button>
    <div style="margin-top:8px;color:#aaa;font-size:11px">提示：大文件下载可能较慢</div>
  </div>`;
}

// ============ 事件绑定 ============
document.addEventListener('DOMContentLoaded', () => {
  // 导航
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(el.dataset.view);
    });
  });

  // 上传按钮
  document.getElementById('uploadBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
  });

  document.getElementById('fileInput').addEventListener('change', (e) => {
    if (e.target.files.length > 0) uploadFiles(e.target.files);
    e.target.value = '';
  });

  // 拖拽上传
  const dropZone = document.getElementById('dropZone');
  dropZone.addEventListener('click', () => document.getElementById('fileInput').click());

  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
  });

  // 全局拖拽
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // 新建文件夹
  document.getElementById('newFolderBtn').addEventListener('click', showFolderModal);
  document.getElementById('cancelFolderBtn').addEventListener('click', () => {
    document.getElementById('folderModal').classList.remove('active');
  });
  document.getElementById('confirmFolderBtn').addEventListener('click', createFolder);
  document.getElementById('folderNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createFolder();
  });

  // 重命名
  document.getElementById('cancelRenameBtn').addEventListener('click', () => {
    document.getElementById('renameModal').classList.remove('active');
  });
  document.getElementById('confirmRenameBtn').addEventListener('click', confirmRename);
  document.getElementById('renameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmRename();
  });

  // 预览关闭
  document.getElementById('closePreviewBtn').addEventListener('click', () => {
    document.getElementById('previewModal').classList.remove('active');
    document.getElementById('previewContent').innerHTML = '';
  });

  document.querySelector('#previewModal .modal-overlay').addEventListener('click', () => {
    document.getElementById('previewModal').classList.remove('active');
    document.getElementById('previewContent').innerHTML = '';
  });

  // 关闭进度
  document.getElementById('closeProgressBtn').addEventListener('click', () => {
    document.getElementById('uploadProgressContainer').style.display = 'none';
  });

  // 搜索
  let searchTimer;
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = e.target.value.trim();
      if (state.currentView === 'channel') {
        state.channelSearchQuery = q;
        state.channelFiles = [];
        state.channelOffset = 0;
        loadChannelFiles();
      } else {
        state.searchQuery = q;
        if (state.searchQuery) {
          searchFiles();
        } else if (state.currentView === 'files') {
          loadView();
        }
      }
    }, 500);
  });

  // ESC 关闭模态框
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    }
  });

  // ============ 移动端侧边栏（汉堡菜单） ============
  const sidebar = document.querySelector('.sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const sidebarOverlay = document.getElementById('sidebarOverlay');

  if (menuToggle) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      sidebarOverlay.classList.toggle('active');
    });
  }

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('active');
    });
  }

  // 点击导航项后关闭移动端侧边栏
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      sidebar.classList.remove('open');
      sidebarOverlay.classList.remove('active');
    });
  });

  // 初始加载（先检查登录状态）
  checkAuth();
});
