# 啟動伺服器（在 PowerShell 執行：.\start.ps1）
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host '正在啟動「小學科學科 AI 批改作業平臺」…' -ForegroundColor Cyan
node server.js
