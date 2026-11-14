# Separate opt-in dev build; preserves the running client and saved preferences.
# Requires PowerShell 7.
param(
    [ValidatePattern('^[A-Za-z0-9_]{1,25}$')][string]$Channel,
    [switch]$Baseline
)
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$manifest = Join-Path $repoRoot 'rust\Cargo.toml'
$trialExe = Join-Path $repoRoot 'rust\target\progressive-source-mp4-trial.exe'
& cargo rustc --locked --manifest-path $manifest -p violetwire --bin violetwire -- -o $trialExe
if ($LASTEXITCODE -ne 0) { throw 'Trial build failed. Close an existing trial window before rebuilding it.' }
$launch = [System.Diagnostics.ProcessStartInfo]::new()
$launch.FileName = $trialExe
$launch.WorkingDirectory = $repoRoot
$launch.UseShellExecute = $false
$launch.CreateNoWindow = $true
foreach ($flag in @('VIOLETWIRE_NO_PARTS', 'VIOLETWIRE_PARTS', 'VIOLETWIRE_PARTS_SPIKE', 'VIOLETWIRE_PARTS_STEER', 'VIOLETWIRE_PARTS_FINISHED_START', 'VIOLETWIRE_CAPTURE_PARTS', 'VIOLETWIRE_PROGRESSIVE_SOURCE', 'VIOLETWIRE_PROGRESSIVE_MP4')) {
    [void]$launch.Environment.Remove($flag)
}
if ($Baseline) {
    $launch.Environment['VIOLETWIRE_NO_PARTS'] = '1'
} else {
    $launch.Environment['VIOLETWIRE_PROGRESSIVE_SOURCE'] = '1'
    $launch.Environment['VIOLETWIRE_PROGRESSIVE_MP4'] = '1'
}
if ($Channel) {
    $launch.ArgumentList.Add('--play')
    $launch.ArgumentList.Add($Channel.ToLowerInvariant())
}
$app = [System.Diagnostics.Process]::Start($launch)
Write-Output "Started progressive TS/fMP4 trial (PID $($app.Id)). Low latency must be on; Balanced uses HLS."
