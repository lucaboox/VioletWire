param(
  [ValidatePattern('^[a-z0-9_]{1,25}$')][string]$Channel = 'summit1g',
  [ValidateSet('gpu','cpu')][string[]]$Backend = @('gpu','cpu')
)
$ErrorActionPreference = 'Stop'
$rustRoot = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $rustRoot 'target\release\violetwire.exe'
$resultsRoot = Join-Path $rustRoot 'target\video-benchmark'
New-Item -ItemType Directory -Force $resultsRoot | Out-Null
if (-not (Test-Path -LiteralPath $exe)) { throw 'Run cargo build --release first.' }

function Measure-Video([string]$Kind) {
  $outPath = Join-Path $resultsRoot "$Kind-out.log"
  $errPath = Join-Path $resultsRoot "$Kind-err.log"
  $probeArgs = @('--play',$Channel,'--video-probe-seconds','35','--mute-video')
  if ($Kind -eq 'cpu') { $probeArgs += '--cpu-video' }
  $probe = Start-Process -FilePath $exe -ArgumentList $probeArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $outPath -RedirectStandardError $errPath
  try {
    Start-Sleep -Seconds 10
    if ($probe.HasExited) { throw "The $Kind probe exited before sampling; inspect $errPath" }
    # Only IDs/parent IDs are read; no process command lines or credentials.
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
    $ids = @([uint32]$probe.Id)
    do {
      $next = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId)
      $ids += $next
    } while ($next.Count -gt 0)
    $initial = @{}
    foreach ($id in $ids) {
      $item = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($item) { $initial[$id] = $item.TotalProcessorTime.TotalSeconds }
    }
    $begin = [Diagnostics.Stopwatch]::StartNew()
    $memory = @()
    for ($i=0; $i -lt 15; $i++) {
      Start-Sleep -Seconds 1
      $sum = 0
      foreach ($id in $ids) {
        $item = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($item) { $sum += $item.PrivateMemorySize64 }
      }
      $memory += $sum
    }
    $cpu = 0
    foreach ($id in $initial.Keys) {
      $item = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($item) { $cpu += $item.TotalProcessorTime.TotalSeconds - $initial[$id] }
    }
    $result = [ordered]@{
      backend = $Kind
      cpuPercentOneCore = [Math]::Round(100*$cpu/$begin.Elapsed.TotalSeconds,1)
      privateMB = [Math]::Round(($memory | Measure-Object -Average).Average/1MB,1)
      processes = $initial.Count
    }
    if (-not $probe.WaitForExit(15000)) { throw "The $Kind probe did not finish." }
    $probe.Refresh()
    if ($probe.ExitCode -ne 0) { throw "The $Kind probe failed; inspect $errPath" }
    $result.diagnostics = [IO.File]::ReadAllText($outPath).Trim()
    $result | ConvertTo-Json -Compress
  } finally {
    # This exact process object was created above. Never kill by program name.
    if (-not $probe.HasExited) { $probe.Kill(); $probe.WaitForExit() }
    $probe.Dispose()
  }
}
foreach ($kind in $Backend) { Measure-Video $kind }
