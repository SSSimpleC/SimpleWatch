$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$localRoot = Join-Path $repoRoot ".local\rtc-predeploy"
if (Test-Path -LiteralPath $localRoot) {
  Remove-Item -LiteralPath $localRoot -Recurse -Force
}
$stateRoot = Join-Path $localRoot "state"
$logRoot = Join-Path $localRoot "logs"
$roots = @("media", "uploads", "inbox", "subtitles") | ForEach-Object {
  Join-Path $localRoot $_
}
$directories = @($stateRoot, $logRoot) + $roots
New-Item -ItemType Directory -Force -Path $directories | Out-Null

$node = Join-Path $repoRoot ".conda\envs\dev\node.exe"
$apiTsx = Join-Path $repoRoot "apps\api\node_modules\tsx\dist\cli.mjs"
$workerTsx = Join-Path $repoRoot "apps\worker\node_modules\tsx\dist\cli.mjs"
$mediaMtx = Join-Path $repoRoot ".cache\mediamtx-1.18.2\mediamtx.exe"
$livekit = Join-Path $repoRoot ".cache\livekit-1.13.1\livekit-server.exe"
foreach ($binary in @($node, $apiTsx, $workerTsx, $mediaMtx, $livekit)) {
  if (-not (Test-Path -LiteralPath $binary)) { throw "缺少 RTC 测试依赖：$binary" }
}

$env:NODE_ENV = "test"
$env:HOST = "127.0.0.1"
$env:PORT = "13900"
$env:DATABASE_PATH = Join-Path $stateRoot "simplewatch.sqlite3"
$env:PUBLIC_ORIGIN = "http://127.0.0.1:18080"
$env:SESSION_SECRET = "rtc-predeploy-session-secret-at-least-32-bytes"
$env:PASSWORD_PEPPER = "rtc-predeploy-password-pepper-at-least-32-bytes"
$env:CONTENT_SIGNING_SECRET = "rtc-predeploy-content-secret-at-least-32-bytes"
$env:INTERNAL_HOOK_TOKEN = "rtc-predeploy-internal-token-at-least-32-bytes"
$env:MEDIA_JWT_SECRET = "rtc-predeploy-media-jwt-secret-at-least-32-bytes"
$env:MEDIA_ORIGIN = "http://127.0.0.1:18889"
$env:LIVEKIT_API_KEY = "predeploy-api-key"
$env:LIVEKIT_API_SECRET = "predeploy-livekit-secret-at-least-32-bytes"
$env:LIVEKIT_URL = "ws://127.0.0.1:17880"
$env:MEDIA_ROOT = $roots[0]
$env:UPLOAD_ROOT = $roots[1]
$env:INBOX_ROOT = $roots[2]
$env:SUBTITLE_ROOT = $roots[3]
$env:TUS_ENDPOINT = "http://127.0.0.1:18080/files/"
$env:ALLOW_ACCOUNT_PROVISION = "fixed-account-replacement"
$env:WORKER_ID = "rtc-native-worker"
$env:API_ORIGIN = "http://127.0.0.1:13900"
$env:FFPROBE_PATH = "ffprobe"
$env:LIVEKIT_INTERNAL_URL = "http://127.0.0.1:17880"
$env:MEDIAMTX_CONTROL_URL = "http://127.0.0.1:19997"

$api = $null
$worker = $null
$mtx = $null
$lk = $null
Push-Location $repoRoot
try {
  $accounts = @(
    @{ username = "Host"; role = "host"; password = "rtc-host-password-24-characters" },
    @{ username = "Simple"; role = "viewer"; password = "rtc-viewer-password-24-chars" },
    @{ username = "FJ233"; role = "viewer"; password = "rtc-fj233-password-24-chars" },
    @{ username = "Conflict"; role = "viewer"; password = "rtc-conflict-password-24-chars" },
    @{ username = "Fpliy"; role = "viewer"; password = "rtc-fpliy-password-24-chars" },
    @{ username = "Lorrence"; role = "viewer"; password = "rtc-lorrence-password-24-chars" }
  ) | ConvertTo-Json -Compress
  $accounts | & $node $apiTsx apps/api/src/cli/admin-bootstrap.ts
  if ($LASTEXITCODE -ne 0) { throw "RTC 管理员初始化失败" }
  $api = Start-Process -FilePath $node -ArgumentList @($apiTsx, "apps/api/src/main.ts") -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "api.out.log") -RedirectStandardError (Join-Path $logRoot "api.err.log")
  $mtx = Start-Process -FilePath $mediaMtx -ArgumentList "infra/mediamtx/mediamtx.native.yml" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "mediamtx.out.log") -RedirectStandardError (Join-Path $logRoot "mediamtx.err.log")
  $lk = Start-Process -FilePath $livekit -ArgumentList @("--config", "infra/livekit/livekit.native.yaml") -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "livekit.out.log") -RedirectStandardError (Join-Path $logRoot "livekit.err.log")

  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    $apiCode = & curl.exe -sS --max-time 1 -o NUL -w "%{http_code}" "http://127.0.0.1:13900/health/ready" 2>$null
    $mtxCode = & curl.exe -sS --max-time 1 -o NUL -w "%{http_code}" "http://127.0.0.1:19997/v3/config/global/get" 2>$null
    $lkCode = & curl.exe -sS --max-time 1 -o NUL -w "%{http_code}" "http://127.0.0.1:17880/" 2>$null
    if ($apiCode -eq "200" -and $mtxCode -eq "200" -and $lkCode -match "^(200|404)$") {
      $ready = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw "RTC 原生栈未在 15 秒内就绪" }
  $worker = Start-Process -FilePath $node -ArgumentList @($workerTsx, "apps/worker/src/main.ts") -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot "worker.out.log") -RedirectStandardError (Join-Path $logRoot "worker.err.log")

  $origin = $env:PUBLIC_ORIGIN
  $login = Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:13900/api/v1/auth/login" -Headers @{ Origin = $origin } -ContentType "application/json" -Body '{"username":"Host","password":"rtc-host-password-24-characters"}'
  $adminCookie = ($login.Headers["Set-Cookie"] -split ";")[0]
  $adminCsrf = ($login.Content | ConvertFrom-Json).csrfToken
  $room = Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:13900/api/v1/rooms" -Headers @{ Origin = $origin; Cookie = $adminCookie; "X-CSRF-Token" = $adminCsrf } -ContentType "application/json" -Body '{}'
  $roomBody = $room.Content | ConvertFrom-Json
  $roomCookie = $adminCookie
  $roomId = $roomBody.room.id
  $roomCsrf = $roomBody.csrfToken
  $credentialHeaders = @{ Origin = $origin; Cookie = $roomCookie; "X-CSRF-Token" = $roomCsrf }
  $voice = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:13900/api/v1/rooms/$roomId/credentials" -Headers $credentialHeaders -ContentType "application/json" -Body '{"purpose":"voice"}'
  $whep = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:13900/api/v1/rooms/$roomId/credentials" -Headers $credentialHeaders -ContentType "application/json" -Body '{"purpose":"whep"}'
  $publish = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:13900/api/v1/rooms/$roomId/live/publish-config" -Headers $credentialHeaders
  $authBody = @{ token = $whep.token; action = "read"; path = $whep.path; id = "native-smoke" } | ConvertTo-Json -Compress
  $authCode = & curl.exe -sS -o NUL -w "%{http_code}" -X POST "http://127.0.0.1:13900/api/v1/internal/mediamtx/auth" -H "Content-Type: application/json" --data-binary $authBody
  $badAuthBody = @{ token = $whep.token; action = "publish"; path = $whep.path } | ConvertTo-Json -Compress
  $badAuthCode = & curl.exe -sS -o NUL -w "%{http_code}" -X POST "http://127.0.0.1:13900/api/v1/internal/mediamtx/auth" -H "Content-Type: application/json" --data-binary $badAuthBody
  if ($authCode -ne "204" -or $badAuthCode -ne "403") { throw "MediaMTX 鉴权正负例失败" }
  $nativeWhepUrl = $whep.url -replace "/program/", "/"
  $invalidOffer = "v=0`r`no=- 0 0 IN IP4 127.0.0.1`r`ns=-`r`nt=0 0`r`n"
  $whepAuthenticatedCode = & curl.exe -sS -o NUL -w "%{http_code}" -X POST $nativeWhepUrl -H "Authorization: Bearer $($whep.token)" -H "Content-Type: application/sdp" --data-binary $invalidOffer
  $whepRejectedCode = & curl.exe -sS -o NUL -w "%{http_code}" -X POST $nativeWhepUrl -H "Authorization: Bearer invalid-token" -H "Content-Type: application/sdp" --data-binary $invalidOffer
  if ($whepAuthenticatedCode -eq "401" -or $whepRejectedCode -ne "401") { throw "真实 MediaMTX WHEP 鉴权链失败" }

  $closeCode = & curl.exe -sS -o NUL -w "%{http_code}" -X PATCH "http://127.0.0.1:13900/api/v1/rooms/$roomId" -H "Origin: $origin" -H "Cookie: $adminCookie" -H "X-CSRF-Token: $roomCsrf" -H "Content-Type: application/json" --data-binary '{"close":true}'
  if ($closeCode -ne "200") { throw "RTC 鉴权样例房间关闭失败：HTTP $closeCode" }

  & pwsh -File tools/environment/run-dev.ps1 pnpm exec playwright test --config playwright.revocation.config.ts --workers=1
  if ($LASTEXITCODE -ne 0) { throw "真实 RTC 撤销测试失败" }

  $result = [ordered]@{
    mediaMtxVersion = (& $mediaMtx --version)
    liveKitVersion = (& $livekit --version)
    apiStatus = $apiCode
    mediaMtxStatus = $mtxCode
    liveKitStatus = $lkCode
    voiceUrl = $voice.url
    whepUrl = $whep.url
    publishUrl = $publish.url
    mediaAuthStatus = [int]$authCode
    mediaWrongActionStatus = [int]$badAuthCode
    whepAuthenticatedMalformedOfferStatus = [int]$whepAuthenticatedCode
    whepInvalidTokenStatus = [int]$whepRejectedCode
    revocationE2E = "passed"
  }
  $resultJson = $result | ConvertTo-Json
  $artifactRoot = Join-Path $repoRoot "artifacts\predeploy\latest"
  New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
  [IO.File]::WriteAllText((Join-Path $artifactRoot "rtc-revocation.json"), $resultJson, [Text.UTF8Encoding]::new($false))
  $resultJson
} finally {
  foreach ($process in @($worker, $lk, $mtx, $api)) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit(5000) | Out-Null
    }
  }
  Pop-Location
}
