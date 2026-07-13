@echo off
:: Telegram 云盘管理系统 - 停止脚本
echo Stopping Telegram Cloud Drive...
taskkill /f /im node.exe 2>nul
if %errorlevel%==0 (
    echo Server stopped.
) else (
    echo Server is not running.
)
pause
