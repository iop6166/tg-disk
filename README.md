# ☁️ Telegram Cloud Drive

基于 Telegram 频道的无限免费云盘管理系统。利用 Telegram 频道作为存储后端，实现文件上传、下载、在线预览、视频播放、文件夹管理等功能。支持 Bot API 和 MTProto API 双模式，突破 50MB 限制，最大支持 4GB 单文件。

---

## ✨ 项目特点

| 特点 | 说明 |
|------|------|
| **无限存储** | 利用 Telegram 频道存储，无容量上限，完全免费 |
| **双模式访问** | Bot API（简单快速）+ MTProto API（大文件支持） |
| **流式播放** | 视频支持拖动进度条、Range 请求、即时播放 |
| **文件管理** | 上传、下载、重命名、删除、复制、剪切、粘贴 |
| **文件夹系统** | 多级文件夹、拖拽上传、面包屑导航 |
| **缩略图预览** | 图片、视频自动生成缩略图 |
| **全文搜索** | 按文件名快速搜索 |
| **存储统计** | 可视化存储使用情况、文件类型分布 |
| **手机适配** | 响应式布局、汉堡菜单、触控优化 |
| **开机自启** | Windows 注册表自启动 + 崩溃自动重启 |
| **域名访问** | Cloudflare Tunnel 绑定域名，自动 HTTPS，无需公网 IP |

---

## 📋 使用条件

运行本项目需要满足以下条件：

### 必需条件

| 条件 | 说明 | 如何获取 |
|------|------|----------|
| **Node.js 22+** | 运行环境（需支持 `node:sqlite`） | [nodejs.org](https://nodejs.org) 下载 LTS 版本 |
| **Telegram Bot Token** | Bot API 凭证 | 在 Telegram 中找 [@BotFather](https://t.me/BotFather) → `/newbot` → 创建后获取 Token |
| **Telegram 频道** | 存储文件用 | Telegram 中创建频道 → 将 Bot 设为频道管理员 |
| **频道 ID** | 标识存储频道 | 将频道消息转发给 [@userinfobot](https://t.me/userinfobot) 获取，格式 `-100xxxxxxxxxx` |

### 可选条件（推荐）

| 条件 | 说明 | 如何获取 |
|------|------|----------|
| **MTProto API ID/Hash** | 大文件支持（4GB）、频道浏览 | 登录 [my.telegram.org](https://my.telegram.org) → API development tools → 创建应用 |
| **代理服务器** | 国内服务器连接 Telegram 需代理 | 安装 Clash/V2Ray 等代理软件，记录本地代理端口 |
| **域名** | 外网访问 | 任意域名注册商购买（推荐 Cloudflare 托管 DNS） |

### 部署条件

| 条件 | 说明 |
|------|------|
| **一台服务器** | Windows/Linux/Mac 均可，需能 24 小时运行 |
| **网络环境** | 服务器需能访问 Telegram（国内需配置代理） |
| **Cloudflare 账号** | 用于 Cloudflare Tunnel 域名绑定（免费） |

---

## 🚀 操作方式

### 第一步：安装

```bash
# 克隆项目
git clone https://github.com/你的用户名/telegram-cloud-drive.git
cd telegram-cloud-drive

# 安装依赖
npm install
```

### 第二步：启动服务器

```bash
node --experimental-sqlite server.js
```

服务器启动后监听 `http://localhost:3000`

### 第三步：配置 Bot API

1. 浏览器打开 `http://localhost:3000`
2. 进入 **设置** 页面
3. 填写：
   - **Bot Token**：从 @BotFather 获取的 Token
   - **Channel ID**：频道 ID（如 `-1003797160750`）
   - **代理地址**：如 `http://127.0.0.1:7890`（国内必填）
4. 点击保存

### 第四步：配置 MTProto（可选，推荐）

MTProto 模式可以浏览频道所有文件、支持 4GB 大文件上传下载。

1. 设置页面 → MTProto 配置
2. 填写 **API ID** 和 **API Hash**（从 [my.telegram.org](https://my.telegram.org) 获取）
3. 点击「发送验证码」
4. 输入手机收到的验证码
5. 登录成功后即可浏览频道所有文件

### 第五步：使用

- **我的云盘**：上传文件（拖拽或点击）、创建文件夹、在线预览
- **频道浏览**：查看 Telegram 频道所有文件、播放视频、下载
- **搜索**：顶部搜索框输入文件名
- **文件操作**：右键或点击文件卡片右上角按钮 → 重命名/删除/复制/剪切/粘贴

---

## 🌐 域名部署（Cloudflare Tunnel）

无需公网 IP、无需开放端口、自动 HTTPS。

### 1. 安装 cloudflared

下载 [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest)（Windows 选 `cloudflared-windows-amd64.exe`）

### 2. 创建 Tunnel

1. 打开 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. Networks → Tunnels → Create a tunnel
3. 选择 Cloudflared 类型，命名隧道
4. 复制安装命令中的 **Token**

### 3. 安装为服务

```bash
cloudflared.exe service install <你的TOKEN>
```

### 4. 配置域名路由

在 Cloudflare 控制台添加 Public Hostname：
- **Subdomain**：留空（用根域名）
- **Domain**：选择你的域名
- **Type**：`HTTP`
- **URL**：`localhost:3000`

### 5. 访问

打开 `https://你的域名.com` 即可访问

---

## ⚙️ 开机自启动

在设置页面 → 系统设置 → 开启「开机自启动」：
- 自动注册到 Windows 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- 通过 `autostart.vbs` 静默启动 `start.bat`
- `start.bat` 含崩溃自动重启机制（10 秒间隔）

---

## 📁 项目结构

```
telegram-cloud-drive/
├── server.js          # 主服务器（Express 路由、API 端点）
├── mtproto.js         # MTProto 核心（GramJS 频道浏览、文件下载）
├── telegram.js        # Bot API 封装（Telegraf）
├── db.js              # SQLite 数据库（node:sqlite）
├── public/
│   ├── index.html     # 前端页面
│   ├── app.js         # SPA 逻辑（文件管理、预览、MTProto 登录）
│   └── style.css      # 样式（含响应式布局）
├── start.bat          # 启动脚本（含崩溃重启）
├── stop.bat           # 停止脚本
├── autostart.vbs      # 静默启动脚本
├── Caddyfile          # Caddy 反向代理配置（备用方案）
├── package.json
├── .gitignore
├── LICENSE
└── README.md
```

---

## ⚠️ 限制条件

### 技术限制

| 限制 | 说明 | 解决方案 |
|------|------|----------|
| **Bot API 50MB 限制** | Bot API 上传/下载单文件最大 50MB | 使用 MTProto 模式，支持 4GB |
| **国内无法直连 Telegram** | 服务器在国内需代理 | 配置 HTTP/SOCKS 代理 |
| **+86 手机号收验证码困难** | Telegram 对中国手机号限制 | 使用已登录设备接收验证码，或用外国号码 |
| **SQLite 并发限制** | `node:sqlite` 不支持高并发 | 个人使用足够，不适合多人场景 |
| **大文件首次加载慢** | 无缓存时需从 Telegram 下载 | 播放后自动缓存，二次播放秒开 |

### 部署限制

| 限制 | 说明 |
|------|------|
| **无法用 Cloudflare Worker 部署** | Express 需持久服务器、SQLite 需文件系统、GramJS 需长连接 |
| **无法用 Vercel/Netlify 部署** | 同上，Serverless 平台不支持 |
| **Cloudflare 缓存大文件** | Cloudflare 免费版对大文件有缓冲，可能影响视频流 |
| **国内手机访问 Cloudflare 域名** | 部分运营商对 Cloudflare CDN 限速，需关闭 VPN 访问网页 |
| **视频在手机端播放** | 国内网络对 Cloudflare 视频流可能不稳定，UI 提供下载备用方案 |

### GramJS 开发注意事项

- 代理参数名为 `socksType`（非 `proxyType`）
- 方法名为驼峰式（`getMessages` 非 `get_messages`）
- `downloadMedia` 的 `outputFile` 参数直接写文件路径（避免内存溢出）
- `getThumb` 不识别 `PhotoSizeProgressive`，需用字符串 type 属性（如 `"m"`）

---

## 🛠️ 技术栈

- **后端**：Node.js 22 + Express + node:sqlite (DatabaseSync)
- **Telegram Bot**：Telegraf
- **Telegram MTProto**：GramJS (`telegram` npm 包)
- **前端**：原生 HTML/CSS/JS（SPA 架构）
- **文件上传**：multer（Latin1→UTF-8 编码修复）
- **代理支持**：https-proxy-agent、socks-proxy-agent
- **部署**：Cloudflare Tunnel（cloudflared）
- **自启动**：Windows 注册表 + VBS 脚本

---

## 📜 License

MIT
