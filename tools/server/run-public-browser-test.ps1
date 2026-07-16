param(
  [Parameter(Mandatory = $true)]
  [string]$CredentialFile
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $CredentialFile).Path
$accounts = Get-Content -LiteralPath $resolved -Raw | ConvertFrom-Json
$hostAccount = $accounts | Where-Object { $_.username -eq 'Host' } | Select-Object -First 1
$viewerAccount = $accounts | Where-Object { $_.username -eq 'Simple' } | Select-Object -First 1
if ($hostAccount.password.Length -lt 20 -or $viewerAccount.password.Length -lt 20) {
  throw '本机固定账户凭据不完整'
}
$env:SIMPLEWATCH_HOST_PASSWORD = $hostAccount.password
$env:SIMPLEWATCH_VIEWER_PASSWORD = $viewerAccount.password
try {
  pwsh -NoProfile -File tools/environment/run-dev.ps1 pnpm exec playwright test --config playwright.server.config.ts
  if ($LASTEXITCODE -ne 0) { throw '公网浏览器测试失败' }
} finally {
  Remove-Item Env:SIMPLEWATCH_HOST_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SIMPLEWATCH_VIEWER_PASSWORD -ErrorAction SilentlyContinue
}
