@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動「小學科學科 AI 批改作業平臺」...
node server.js
if errorlevel 1 (
  echo.
  echo 啟動失敗。請確認已安裝 Node.js 22 或以上（node -v 可查看版本）。
  pause
)
