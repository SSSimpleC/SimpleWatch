$ErrorActionPreference = 'Stop'
$credentialLines = ssh admin@8.134.239.34 'sudo cat /root/simplewatch-initial-credentials'
if ($LASTEXITCODE -ne 0) { throw '无法读取服务器测试凭据' }
$credentials = @{}
foreach ($line in $credentialLines) {
  $parts = $line -split '=', 2
  if ($parts.Count -eq 2) { $credentials[$parts[0]] = $parts[1] }
}
if ($credentials.CODE -notmatch '^\d{6}$') { throw '服务器测试口令不完整' }
$env:SIMPLEWATCH_ADMIN_CODE = $credentials.CODE
try {
  pwsh -NoProfile -File tools/environment/run-dev.ps1 pnpm exec playwright test --config playwright.server.config.ts
  if ($LASTEXITCODE -ne 0) { throw '公网浏览器测试失败' }
} finally {
  Remove-Item Env:SIMPLEWATCH_ADMIN_CODE -ErrorAction SilentlyContinue
}
