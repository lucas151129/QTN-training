# 備份（PowerShell 包裝：先熱備份，再壓成 zip）
# 用法：右鍵「用 PowerShell 執行」，或在這裡執行 .\備份.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root '程式'

Set-Location -LiteralPath $app
node scripts/backup.mjs $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw '備份失敗，請看上面的錯誤訊息。' }

$latest = Get-ChildItem -LiteralPath $PSScriptRoot -Directory -Filter 'backup-*' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latest) {
  $zip = Join-Path $PSScriptRoot ($latest.Name + '.zip')
  if (-not (Test-Path -LiteralPath $zip)) {
    Compress-Archive -LiteralPath $latest.FullName -DestinationPath $zip -CompressionLevel Optimal
    Write-Host "已壓縮：$zip" -ForegroundColor Green
  }
  Write-Host "備份完成：$($latest.FullName)" -ForegroundColor Green
}
