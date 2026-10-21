param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot 'runtime'
$statePath = Join-Path $runtimePath 'process.json'
$shopUrl = 'http://127.0.0.1:18080'

function Get-RecordedProcess($record) {
    $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Path -eq $record.exe -and
        $candidate.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.start_time_ticks) { return $candidate }
}
function Test-LocalRedis {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        if (-not $client.ConnectAsync('127.0.0.1', 16379).Wait(1500)) { return $false }
        $stream = $client.GetStream(); $stream.ReadTimeout = 1500
        $config = Get-Content -LiteralPath (Join-Path $runtimePath 'redis\redis.conf') -Raw
        $secret = [regex]::Match($config, '(?m)^requirepass ([a-f0-9]+)').Groups[1].Value
        if (-not $secret) { return $false }
        $bytes = [Text.Encoding]::ASCII.GetBytes("AUTH $secret`r`nPING`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $buffer = New-Object byte[] 1024
        $reply = ''
        while ($reply.Length -lt 1024) {
            $count = $stream.Read($buffer, 0, $buffer.Length)
            if ($count -eq 0) { break }
            $reply += [Text.Encoding]::ASCII.GetString($buffer, 0, $count)
            if ($reply.Contains('+PONG')) { return $true }
        }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}
function Test-HttpReady($url, $mock = $false) {
    try {
        $health = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2
        return ($health.status -eq 'ok' -and (-not $mock -or $health.mock -eq 'epay-local'))
    } catch { return $false }
}
function Show-Ready {
    Write-Output "本地测试商城已启动：$shopUrl"
    Write-Output '后台任务和模拟收银台已启用；只能演练，不会真实收款。'
    if ($OpenBrowser) { Start-Process -FilePath $shopUrl }
}
if (Test-Path -LiteralPath $statePath) {
    $previous = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $running = @($previous.services | Where-Object { Get-RecordedProcess $_ })
    if ($running.Count -eq 3 -and (Test-LocalRedis) -and
        (Test-HttpReady 'http://127.0.0.1:18081' $true) -and (Test-HttpReady $shopUrl)) { Show-Ready; return }
    & (Join-Path $PSScriptRoot 'Stop-LocalShop.ps1')
}
foreach ($port in @(16379, 18081, 18080)) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
    try { $listener.Start() } finally { $listener.Stop() }
}
$services = @()
function Start-RecordedService($name, $exe, $arguments, $directory) {
    $serviceProcess = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $directory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimePath "$name.stdout.log") -RedirectStandardError (Join-Path $runtimePath "$name.stderr.log") -PassThru
    $script:services += @{name=$name; pid=$serviceProcess.Id; exe=$exe; start_time_ticks=$serviceProcess.StartTime.ToUniversalTime().Ticks.ToString()}
    @{services=@($script:services); url=$shopUrl; mode='all'; queue_enabled=$true} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding utf8
    return $serviceProcess
}
$redisExe = Join-Path $PSScriptRoot 'redis-8.10.2\Redis-8.10.2-Windows-x64-cygwin\redis-server.exe'
$redisProcess = Start-RecordedService 'redis' $redisExe @('redis.conf') (Join-Path $runtimePath 'redis')
$redisReady = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-LocalRedis) { $redisReady = $true; break }
    $redisProcess.Refresh()
    if ($redisProcess.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $redisReady) { throw '本地任务服务未能启动，请检查 runtime 下的 Redis 日志。' }
$gatewayScript = Join-Path $PSScriptRoot 'testing\MockPayment.mjs'
$gatewayProcess = Start-RecordedService 'mock-payment' 'D:\nodejs\node.exe' @('"' + $gatewayScript + '"') $runtimePath
$appExe = Join-Path $PSScriptRoot 'app-v1.5.0\dujiao-next.exe'
$appProcess = Start-RecordedService 'app' $appExe @('-mode', 'all') $runtimePath
$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if ((Test-HttpReady $shopUrl) -and (Test-HttpReady 'http://127.0.0.1:18081' $true)) { $ready=$true; break }
    $appProcess.Refresh(); $gatewayProcess.Refresh()
    if ($appProcess.HasExited -or $gatewayProcess.HasExited) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw '商城或模拟收银台未能启动，请检查 runtime 下的本地日志。' }
Show-Ready