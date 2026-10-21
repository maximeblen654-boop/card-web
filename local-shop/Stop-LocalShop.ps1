$ErrorActionPreference = 'Stop'
$runtimePath = Join-Path $PSScriptRoot 'runtime'
$statePath = Join-Path $runtimePath 'process.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output '本地测试商城没有运行记录。'; return }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$records = @($state.services)
if (-not $state.services -and $state.pid) { $records=@(@{name='app';pid=$state.pid;exe=$state.exe}) }
foreach ($record in @($records | Sort-Object @{Expression={if ($_.name -eq 'app') {0} elseif ($_.name -eq 'mock-payment') {1} else {2}}})) {
    $serviceProcess = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if (-not $serviceProcess) { continue }
    if ($serviceProcess.Path -ne $record.exe -or ($record.start_time_ticks -and
        $serviceProcess.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.start_time_ticks)) { throw '进程编号已属于其他程序，已停止操作。' }
    if ($record.name -eq 'redis') {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            if (-not $client.ConnectAsync('127.0.0.1', 16379).Wait(1500)) { throw 'Redis 连接超时' }
            $stream=$client.GetStream(); $stream.ReadTimeout=1500
            $config=Get-Content -LiteralPath (Join-Path $runtimePath 'redis\redis.conf') -Raw
            $secret=[regex]::Match($config,'(?m)^requirepass ([a-f0-9]+)').Groups[1].Value
            if (-not $secret) { throw '找不到本地 Redis 密码' }
            $bytes=[Text.Encoding]::ASCII.GetBytes("AUTH $secret`r`nSHUTDOWN SAVE`r`n")
            $stream.Write($bytes,0,$bytes.Length)
        } finally { $client.Dispose() }
        if (-not $serviceProcess.WaitForExit(10000)) { throw 'Redis 尚未完成保存，已保留运行记录。' }
    } else {
        Stop-Process -Id $serviceProcess.Id
        $serviceProcess.WaitForExit(5000) | Out-Null
    }
}
Remove-Item -LiteralPath $statePath
Write-Output '本地测试商城及后台任务已停止，商品和订单保留在 D 盘。'