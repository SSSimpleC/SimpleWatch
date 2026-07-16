$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$localRoot = Join-Path $repoRoot '.local\predeploy'
if (-not $localRoot.StartsWith((Join-Path $repoRoot '.local'))) {
  throw '测试目录越界'
}
if (Test-Path -LiteralPath $localRoot) {
  Remove-Item -LiteralPath $localRoot -Recurse -Force
}
$stateRoot = Join-Path $localRoot 'state'
$mediaRoot = Join-Path $localRoot 'media'
$uploadRoot = Join-Path $localRoot 'uploads'
$inboxRoot = Join-Path $localRoot 'inbox'
$subtitleRoot = Join-Path $localRoot 'subtitles'
$logRoot = Join-Path $localRoot 'logs'
New-Item -ItemType Directory -Force -Path $stateRoot, $mediaRoot, $uploadRoot, $inboxRoot, $subtitleRoot, $logRoot | Out-Null

$node = Join-Path $repoRoot '.conda\envs\dev\node.exe'
$apiTsx = Join-Path $repoRoot 'apps\api\node_modules\tsx\dist\cli.mjs'
$workerTsx = Join-Path $repoRoot 'apps\worker\node_modules\tsx\dist\cli.mjs'
$ffprobe = Join-Path $repoRoot '.conda\envs\dev\Library\bin\ffprobe.exe'
$caddy = Join-Path $repoRoot '.cache\caddy-2.11.4\caddy.exe'
$tusd = Join-Path $repoRoot '.cache\tusd-2.9.2\tusd_windows_amd64\tusd.exe'
foreach ($binary in $node, $apiTsx, $workerTsx, $ffprobe, $caddy, $tusd) {
  if (-not (Test-Path -LiteralPath $binary)) { throw "缺少测试依赖：$binary" }
}

$env:NODE_ENV = 'test'
$env:HOST = '127.0.0.1'
$env:PORT = '13900'
$env:DATABASE_PATH = Join-Path $stateRoot 'simplewatch.sqlite3'
$env:PUBLIC_ORIGIN = 'http://127.0.0.1:18080'
$env:SESSION_SECRET = 'predeploy-session-secret-at-least-32-bytes'
$env:PASSWORD_PEPPER = 'predeploy-password-pepper-at-least-32-bytes'
$env:CONTENT_SIGNING_SECRET = 'predeploy-content-secret-at-least-32-bytes'
$env:INTERNAL_HOOK_TOKEN = 'predeploy-internal-token-at-least-32-bytes'
$env:MEDIA_JWT_SECRET = 'predeploy-media-jwt-secret-at-least-32-bytes'
$env:MEDIA_ORIGIN = 'http://127.0.0.1:18080'
$env:LIVEKIT_API_KEY = 'predeploy-api-key'
$env:LIVEKIT_API_SECRET = 'predeploy-livekit-secret-at-least-32-bytes'
$env:LIVEKIT_URL = 'ws://127.0.0.1:17880'
$env:MEDIA_ROOT = $mediaRoot
$env:UPLOAD_ROOT = $uploadRoot
$env:INBOX_ROOT = $inboxRoot
$env:SUBTITLE_ROOT = $subtitleRoot
$env:TUS_ENDPOINT = 'http://127.0.0.1:18080/files/'
$env:ALLOW_ACCOUNT_PROVISION = 'fixed-account-replacement'
$env:WORKER_ID = 'predeploy-worker'
$env:API_ORIGIN = 'http://127.0.0.1:13900'
$env:FFPROBE_PATH = $ffprobe
$env:LIVEKIT_INTERNAL_URL = 'http://127.0.0.1:17880'
$env:MEDIAMTX_CONTROL_URL = 'http://127.0.0.1:19997'

Push-Location $repoRoot
$apiProcess = $null
$workerProcess = $null
$caddyProcess = $null
$tusdProcess = $null
try {
  $accounts = @(
    @{ username = 'Host'; role = 'host'; password = 'range-host-password-24-characters' },
    @{ username = 'Simple'; role = 'viewer'; password = 'range-viewer-password-24-chars' },
    @{ username = 'FJ233'; role = 'viewer'; password = 'range-fj233-password-24-chars' },
    @{ username = 'Conflict'; role = 'viewer'; password = 'range-conflict-password-24-chars' },
    @{ username = 'Fpliy'; role = 'viewer'; password = 'range-fpliy-password-24-chars' },
    @{ username = 'Lorrence'; role = 'viewer'; password = 'range-lorrence-password-24-chars' }
  ) | ConvertTo-Json -Compress
  $accounts | & $node $apiTsx apps/api/src/cli/admin-bootstrap.ts
  if ($LASTEXITCODE -ne 0) { throw '测试管理员初始化失败' }

  & $caddy validate --config infra/caddy/Caddyfile.predeploy --adapter caddyfile
  if ($LASTEXITCODE -ne 0) { throw 'Caddy 配置校验失败' }

  $apiProcess = Start-Process -FilePath $node -ArgumentList @($apiTsx, 'apps/api/src/main.ts') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'api.out.log') -RedirectStandardError (Join-Path $logRoot 'api.err.log')
  $workerProcess = Start-Process -FilePath $node -ArgumentList @($workerTsx, 'apps/worker/src/main.ts') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'worker.out.log') -RedirectStandardError (Join-Path $logRoot 'worker.err.log')
  $tusdArgs = @('-host=127.0.0.1', '-port=11080', '-base-path=/files/', '-behind-proxy', "-upload-dir=$uploadRoot", '-hooks-http=http://127.0.0.1:18080/api/v1/internal/tus/hooks', '-hooks-http-forward-headers=Upload-Token', '-hooks-enabled-events=pre-create,post-create,post-receive,post-finish,post-terminate')
  $tusdProcess = Start-Process -FilePath $tusd -ArgumentList $tusdArgs -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'tusd.out.log') -RedirectStandardError (Join-Path $logRoot 'tusd.err.log')
  $caddyProcess = Start-Process -FilePath $caddy -ArgumentList @('run', '--config', 'infra/caddy/Caddyfile.predeploy', '--adapter', 'caddyfile') -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logRoot 'caddy.out.log') -RedirectStandardError (Join-Path $logRoot 'caddy.err.log')

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    $healthStatus = & curl.exe -sS --max-time 1 -o NUL -w '%{http_code}' 'http://127.0.0.1:18080/health/ready' 2>$null
    if ($healthStatus -eq '200') { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw '本地栈未在 10 秒内就绪' }

  $edgeHeaders = Invoke-WebRequest -Method Get -Uri 'http://127.0.0.1:18080/'
  if ($edgeHeaders.Headers['X-Content-Type-Options'] -ne 'nosniff') { throw '边缘缺少 nosniff' }
  if ($edgeHeaders.Headers['X-Frame-Options'] -ne 'DENY') { throw '边缘缺少 frame 拒绝策略' }
  if ($edgeHeaders.Headers['Content-Security-Policy'] -notmatch "default-src 'self'") { throw '边缘缺少 CSP' }

  $login = Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:18080/api/v1/auth/login' -Headers @{ Origin = $env:PUBLIC_ORIGIN } -ContentType 'application/json' -Body '{"username":"Host","password":"range-host-password-24-characters"}'
  $cookie = ($login.Headers['Set-Cookie'] -split ';')[0]
  $csrf = ($login.Content | ConvertFrom-Json).csrfToken
  if (-not $cookie -or -not $csrf) { throw '登录未返回会话或 CSRF' }

  $sample = Join-Path $repoRoot 'test-data\generated\media-smoke.mp4'
  if (-not (Test-Path -LiteralPath $sample)) { throw '缺少媒体样片，请先运行 pnpm test:media' }
  $bytes = (Get-Item -LiteralPath $sample).Length
  $authorizeBody = @{ filename = 'range-smoke.mp4'; bytes = $bytes; mime = 'video/mp4' } | ConvertTo-Json -Compress
  $authorize = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:18080/api/v1/uploads/authorize' -Headers @{ Origin = $env:PUBLIC_ORIGIN; Cookie = $cookie; 'X-CSRF-Token' = $csrf } -ContentType 'application/json' -Body $authorizeBody
  $filenameMetadata = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('range-smoke.mp4'))
  $typeMetadata = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('video/mp4'))
  $createHeaders = Join-Path $localRoot 'tus-create.headers'
  $createStatus = & curl.exe -sS -o NUL -D $createHeaders -w '%{http_code}' -X POST 'http://127.0.0.1:18080/files/' -H 'Tus-Resumable: 1.0.0' -H "Upload-Length: $bytes" -H "Upload-Metadata: filename $filenameMetadata,filetype $typeMetadata" -H "Upload-Token: $($authorize.uploadToken)"
  if ($createStatus -ne '201') { throw "tus 创建应返回 201，实际 $createStatus" }
  $uploadLocationLine = Get-Content -LiteralPath $createHeaders | Where-Object { $_ -match '^Location:' } | Select-Object -First 1
  $uploadLocation = ($uploadLocationLine -replace '^Location:\s*', '').Trim()
  if ($uploadLocation.StartsWith('/')) { $uploadLocation = "http://127.0.0.1:18080$uploadLocation" }
  if (-not $uploadLocation) { throw 'tus 创建未返回 Location' }

  $sampleBytes = [IO.File]::ReadAllBytes($sample)
  $firstLength = [Math]::Floor($sampleBytes.Length / 2)
  $firstPart = Join-Path $localRoot 'upload.part1'
  $secondPart = Join-Path $localRoot 'upload.part2'
  [IO.File]::WriteAllBytes($firstPart, $sampleBytes[0..($firstLength - 1)])
  [IO.File]::WriteAllBytes($secondPart, $sampleBytes[$firstLength..($sampleBytes.Length - 1)])
  $patchOne = & curl.exe -sS -o NUL -w '%{http_code}' -X PATCH $uploadLocation -H 'Tus-Resumable: 1.0.0' -H 'Upload-Offset: 0' -H 'Content-Type: application/offset+octet-stream' -H "Upload-Token: $($authorize.uploadToken)" --data-binary "@$firstPart"
  if ($patchOne -ne '204') { throw "tus 首段应返回 204，实际 $patchOne" }
  $headHeaders = Join-Path $localRoot 'tus-head.headers'
  $headStatus = & curl.exe -sS --max-time 10 -o NUL -D $headHeaders -w '%{http_code}' -I $uploadLocation -H 'Tus-Resumable: 1.0.0' -H "Upload-Token: $($authorize.uploadToken)"
  if ($headStatus -ne '200') { throw "tus 断点 HEAD 应返回 200，实际 $headStatus" }
  $reportedOffset = ((Get-Content -LiteralPath $headHeaders | Where-Object { $_ -match '^Upload-Offset:' } | Select-Object -First 1) -replace '^Upload-Offset:\s*', '').Trim()
  if ($reportedOffset -ne "$firstLength") { throw "tus 断点偏移错误：$reportedOffset" }
  $mediaBeforeFinish = Invoke-RestMethod -Uri 'http://127.0.0.1:18080/api/v1/media' -Headers @{ Cookie = $cookie }
  if ($mediaBeforeFinish.Count -ne 0) { throw '半文件不得进入媒体库' }
  $patchTwo = & curl.exe -sS -o NUL -w '%{http_code}' -X PATCH $uploadLocation -H 'Tus-Resumable: 1.0.0' -H "Upload-Offset: $firstLength" -H 'Content-Type: application/offset+octet-stream' -H "Upload-Token: $($authorize.uploadToken)" --data-binary "@$secondPart"
  if ($patchTwo -ne '204') { throw "tus 续传段应返回 204，实际 $patchTwo" }

  $published = $false
  $mediaId = $null
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    $mediaList = Invoke-RestMethod -Uri 'http://127.0.0.1:18080/api/v1/media' -Headers @{ Cookie = $cookie }
    $media = $mediaList | Where-Object { $_.displayName -eq 'range-smoke.mp4' } | Select-Object -First 1
    if ($null -ne $media -and $media.state -eq 'published') { $published = $true; $mediaId = $media.id; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $published) { throw 'Worker 未在 20 秒内发布媒体' }

  & $node 'node_modules/@playwright/test/cli.js' test --config playwright.fullstack.config.ts
  if ($LASTEXITCODE -ne 0) { throw '真实浏览器全栈流程失败' }

  $entryHeadersPath = Join-Path $localRoot 'entry.headers'
  $entryStatus = & curl.exe -sS -o NUL -D $entryHeadersPath -w '%{http_code}' -H "Cookie: $cookie" "http://127.0.0.1:18080/api/v1/media/$mediaId/content"
  if ($entryStatus -ne '307') { throw "内容入口应返回 307，实际 $entryStatus" }
  $locationLine = Get-Content -LiteralPath $entryHeadersPath | Where-Object { $_ -match '^Location:' } | Select-Object -First 1
  $location = ($locationLine -replace '^Location:\s*', '').Trim()
  if (-not $location) { throw '内容入口未返回 Location' }
  $contentUrl = "http://127.0.0.1:18080$location"
  $headersPath = Join-Path $localRoot 'range.headers'
  $bodyPath = Join-Path $localRoot 'range.body'
  & curl.exe -sS -D $headersPath -o $bodyPath -H "Cookie: $cookie" -H 'Range: bytes=0-99' $contentUrl
  if ($LASTEXITCODE -ne 0) { throw 'Range 请求失败' }
  $headers = Get-Content -LiteralPath $headersPath -Raw
  if ($headers -notmatch 'HTTP/1\.1 206') { throw '单 Range 未返回 206' }
  if ((Get-Item -LiteralPath $bodyPath).Length -ne 100) { throw '单 Range 响应长度不是 100 字节' }

  $status416 = & curl.exe -sS -o NUL -w '%{http_code}' -H "Cookie: $cookie" -H "Range: bytes=$($bytes + 100)-" $contentUrl
  if ($status416 -ne '416') { throw "越界 Range 应返回 416，实际 $status416" }
  $multi416 = & curl.exe -sS -o NUL -w '%{http_code}' -H "Cookie: $cookie" -H 'Range: bytes=0-1,4-5' $contentUrl
  if ($multi416 -ne '416') { throw "多 Range 应返回 416，实际 $multi416" }
  $unauthorized = & curl.exe -sS -o NUL -w '%{http_code}' -H 'Range: bytes=0-9' $contentUrl
  if ($unauthorized -ne '401') { throw "未认证 Range 应返回 401，实际 $unauthorized" }

  [pscustomobject]@{
    mediaId = $mediaId
    bytes = $bytes
    tusCreateStatus = 201
    tusFirstPatchStatus = 204
    tusResumeOffset = $firstLength
    tusFinalPatchStatus = 204
    rangeStatus = 206
    rangeBytes = 100
    unsatisfiedRangeStatus = 416
    multipleRangeStatus = 416
    unauthorizedStatus = 401
  } | ConvertTo-Json
} finally {
  foreach ($process in $caddyProcess, $tusdProcess, $workerProcess, $apiProcess) {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit()
    }
  }
  Pop-Location
}
