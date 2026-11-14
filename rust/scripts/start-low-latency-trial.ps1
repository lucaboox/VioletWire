# Builds a separate dev executable; does not stop or replace the running client.
# Requires PowerShell 7. The experiment is enabled only for the child process.
param(
    [ValidatePattern('^[A-Za-z0-9_]{1,25}$')][string]$Channel,
    [switch]$Baseline
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Join-Path $repoRoot 'rust\Cargo.toml'
$trialExe = Join-Path $repoRoot 'rust\target\latency-trial.exe'
& cargo rustc --locked --manifest-path $manifest -p violetwire --bin violetwire -- -o $trialExe
if ($LASTEXITCODE -ne 0) { throw 'Trial build failed. Close an existing trial window before rebuilding it.' }
$launch = [System.Diagnostics.ProcessStartInfo]::new()
$launch.FileName = $trialExe
$launch.WorkingDirectory = $repoRoot
$launch.UseShellExecute = $false
$launch.CreateNoWindow = $true
foreach ($flag in @('VIOLETWIRE_NO_PARTS', 'VIOLETWIRE_PARTS_SPIKE', 'VIOLETWIRE_PARTS_STEER', 'VIOLETWIRE_PARTS_FINISHED_START')) {
    [void]$launch.Environment.Remove($flag)
}
$launch.Environment['VIOLETWIRE_PARTS'] = '1'
if ($Baseline) { $launch.Environment['VIOLETWIRE_NO_PARTS'] = '1' }
if ($Channel) {
    $launch.ArgumentList.Add('--play')
    $launch.ArgumentList.Add($Channel.ToLowerInvariant())
}
$app = [System.Diagnostics.Process]::Start($launch)
Write-Output "Started Rust latency trial (PID $($app.Id)). Low latency in Settings must be on; Balanced bypasses the experiment."
