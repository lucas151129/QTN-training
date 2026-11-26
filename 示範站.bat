@echo off
chcp 65001 >nul
title QTN 示範站（對外）
cd /d "%~dp0程式"

set AI_MODE=mock
set PORT=8788

echo.
echo  ==========================================================
echo    AI 批改作業平臺 · 對外示範站
echo    模式：模擬（不接真模型，不會花錢）
echo  ==========================================================
echo.

start "AI 批改示範站（請勿關閉）" cmd /k node server.js
timeout /t 3 >nul

echo  下面會出現一條 https:// 網址，複製它給老師。
echo.
echo   * 這個黑色視窗要一直開著，關掉就斷線。
echo   * 網址每次重開都不同，明天重新開這個檔就會有新網址。
echo   * 任何人拿到網址都可以登入 teacher / 1234，示範完請關窗。
echo.

ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8788 serveo.net

echo.
echo  隧道已斷線。按任意鍵關閉。
pause >nul
