@echo off
chcp 65001 >nul
title QTN 示範站（對外）
cd /d "%~dp0程式"

set AI_MODE=mock
set PORT=8788
set CF=%LOCALAPPDATA%\cloudflared\cloudflared.exe

if not exist "%CF%" goto nocf

echo.
echo  ==========================================================
echo    AI 批改作業平臺 · 對外示範站
echo    模式：模擬（不接真模型，不會花錢）
echo  ==========================================================
echo.

start "AI 批改示範站（請勿關閉）" cmd /k node server.js
timeout /t 3 >nul

echo  下面會出現一行：
echo      https://xxxx-xxxx-xxxx.trycloudflare.com
echo.
echo  那就是給老師的網址。複製它。
echo.
echo   * 這個黑色視窗要一直開著，關掉就斷線。
echo   * 網址每次重開都不同，明天重新開這個檔就會有新網址。
echo   * 任何人拿到網址都可以登入 teacher / 1234，示範完請關窗。
echo.

"%CF%" tunnel --url http://127.0.0.1:8788 --no-autoupdate --protocol http2

echo.
echo  隧道已斷線。按任意鍵關閉。
pause >nul
exit /b 0

:nocf
echo.
echo  找不到 cloudflared.exe
echo  應該是：%CF%
echo.
echo  安裝方法（二選一）：
echo    1. winget install Cloudflare.cloudflared
echo    2. 或者下載 cloudflared-windows-amd64.exe 改名 cloudflared.exe
echo       放到 %LOCALAPPDATA%\cloudflared\
echo.
pause
