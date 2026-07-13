#!/bin/bash
# ============================================================
# Telegram Cloud Drive - 一键部署脚本 (Linux)
# 适用于: Debian/Ubuntu VPS (512MB+ RAM)
# 功能: 安装 Node.js 22 + 部署项目 + Cloudflare Tunnel + 开机自启
# ============================================================

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Telegram Cloud Drive 一键部署脚本${NC}"
echo -e "${GREEN}========================================${NC}"

# 检查 root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}请用 root 用户运行: sudo bash deploy.sh${NC}"
  exit 1
fi

INSTALL_DIR="/opt/telegram-cloud-drive"
SWAP_SIZE="512M"

# ============ 1. 创建 Swap（512MB 内存必须加）============
echo -e "${YELLOW}[1/8] 创建 Swap 交换空间...${NC}"
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=512 2>/dev/null
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo -e "${GREEN}  Swap 512MB 已创建${NC}"
else
  echo -e "${GREEN}  Swap 已存在，跳过${NC}"
fi

# ============ 2. 安装 Node.js 22 ============
echo -e "${YELLOW}[2/8] 安装 Node.js 22...${NC}"
if command -v node &>/dev/null && [ $(node -v | cut -d. -f1 | tr -d v) -ge 22 ]; then
  echo -e "${GREEN}  Node.js $(node -v) 已安装${NC}"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  echo -e "${GREEN}  Node.js $(node -v) 安装完成${NC}"
fi

# ============ 3. 安装 cloudflared ============
echo -e "${YELLOW}[3/8] 安装 cloudflared...${NC}"
if command -v cloudflared &>/dev/null; then
  echo -e "${GREEN}  cloudflared 已安装${NC}"
else
  curl -L --output /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
  echo -e "${GREEN}  cloudflared 安装完成${NC}"
fi

# ============ 4. 部署项目代码 ============
echo -e "${YELLOW}[4/8] 部署项目代码...${NC}"
mkdir -p $INSTALL_DIR

# 从 GitHub 下载（如果用户有 GitHub 仓库可替换 URL）
# 这里用内嵌方式写入核心文件
cat > $INSTALL_DIR/package.json << 'PKGEOF'
{
  "name": "telegram-cloud-drive",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node --experimental-sqlite server.js"
  },
  "dependencies": {
    "express": "^4.21.0",
    "multer": "^1.4.5-lts.1",
    "telegraf": "^4.16.3",
    "telegram": "^2.26.21",
    "https-proxy-agent": "^7.0.5",
    "socks-proxy-agent": "^8.0.4"
  }
}
PKGEOF

echo -e "${YELLOW}  请将项目文件（server.js, mtproto.js, telegram.js, db.js, public/）上传到 $INSTALL_DIR${NC}"
echo -e "${YELLOW}  可以用 scp 从你的电脑上传:${NC}"
echo -e "  scp -P 54842 -r *.js public root@66.63.182.165:$INSTALL_DIR/"

# ============ 5. 安装依赖 ============
echo -e "${YELLOW}[5/8] 安装 npm 依赖...${NC}"
if [ -f $INSTALL_DIR/server.js ]; then
  cd $INSTALL_DIR
  npm install --production 2>/dev/null || npm install --production
  echo -e "${GREEN}  依赖安装完成${NC}"
else
  echo -e "${RED}  server.js 不存在，请先上传项目文件${NC}"
  echo -e "${YELLOW}  上传后重新运行: cd $INSTALL_DIR && npm install --production${NC}"
fi

# ============ 6. 创建 systemd 服务 ============
echo -e "${YELLOW}[6/8] 创建系统服务...${NC}"
cat > /etc/systemd/system/tg-cloud-drive.service << SVCEOF
[Unit]
Description=Telegram Cloud Drive
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) --experimental-sqlite server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:$INSTALL_DIR/server.log
StandardError=append:$INSTALL_DIR/server.log

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable tg-cloud-drive
echo -e "${GREEN}  系统服务已创建（开机自启 + 崩溃重启）${NC}"

# ============ 7. Cloudflare Tunnel 服务 ============
echo -e "${YELLOW}[7/8] 配置 Cloudflare Tunnel...${NC}"
CF_TOKEN=""
read -p "  请输入 Cloudflare Tunnel Token（直接回车跳过）: " CF_TOKEN
if [ -n "$CF_TOKEN" ]; then
  cat > /etc/systemd/system/cloudflared.service << CFEOF
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token $CF_TOKEN
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
CFEOF
  systemctl daemon-reload
  systemctl enable cloudflared
  systemctl start cloudflared
  echo -e "${GREEN}  Cloudflare Tunnel 已启动${NC}"
else
  echo -e "${YELLOW}  跳过 Cloudflare Tunnel，稍后手动配置${NC}"
fi

# ============ 8. 启动服务 ============
echo -e "${YELLOW}[8/8] 启动服务...${NC}"
if [ -f $INSTALL_DIR/server.js ]; then
  systemctl start tg-cloud-drive
  sleep 3
  if systemctl is-active --quiet tg-cloud-drive; then
    echo -e "${GREEN}  服务已启动 ✓${NC}"
  else
    echo -e "${RED}  服务启动失败，查看日志: journalctl -u tg-cloud-drive -f${NC}"
  fi
fi

# ============ 完成 ============
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "项目目录: $INSTALL_DIR"
echo "启动服务: systemctl start tg-cloud-drive"
echo "停止服务: systemctl stop tg-cloud-drive"
echo "查看日志: journalctl -u tg-cloud-drive -f"
echo "重启服务: systemctl restart tg-cloud-drive"
echo ""
echo -e "${YELLOW}下一步:${NC}"
echo "  1. 上传项目文件到 $INSTALL_DIR（如果没有的话）"
echo "  2. 访问 http://localhost:3000 配置 Bot Token"
echo "  3. 如果配了 Cloudflare Tunnel，访问你的域名"
echo ""
echo -e "${YELLOW}内存优化提示:${NC}"
echo "  Swap 已创建 512MB，总可用内存约 1GB"
echo "  不要同时下载多个大文件"
