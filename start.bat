@echo off
:: Telegram 云盘管理系统 - 自动启动脚本
:: 功能：开机自启动 + 崩溃自动重启 + 静默后台运行
:: 注意：Cloudflare Tunnel 已安装为 Windows 服务（Cloudflared），会自动启动，无需在此启动

set NODE_EXE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2\node.exe
set APP_DIR=C:\Users\Administrator\WorkBuddy\2026-07-08-00-40-29\telegram-cloud-drive
set LOG_FILE=%APP_DIR%\server.log

cd /d "%APP_DIR%"

:loop
echo [%date% %time%] Starting Telegram Cloud Drive... >> "%LOG_FILE%"
"%NODE_EXE%" --experimental-sqlite server.js >> "%LOG_FILE%" 2>&1

echo [%date% %time%] Server crashed or exited, restarting in 5 seconds... >> "%LOG_FILE%"
timeout /t 5 /nobreak >nul
goto loop
