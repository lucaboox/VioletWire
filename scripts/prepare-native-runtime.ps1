$ErrorActionPreference = "Stop"

$streamlinkVersion = "8.4.0-1"
$streamlinkArchiveName = "streamlink-8.4.0-1-py314-x86_64.zip"
$streamlinkUrl = "https://github.com/streamlink/windows-builds/releases/download/8.4.0-1/$streamlinkArchiveName"
$streamlinkSha256 = "A8D3BD2B409E6D1B1F7A0E2A5C0CBFBA619775E475DA3F31285AF08D680FB71C"

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cacheDirectory = Join-Path $workspace ".cache\native-runtime"
$nativeDirectory = Join-Path $workspace "vendor\native"
$streamlinkDirectory = Join-Path $nativeDirectory "streamlink"
$manifestPath = Join-Path $nativeDirectory "versions.json"

function Assert-WorkspaceChild([string]$candidate) {
  $absolute = [System.IO.Path]::GetFullPath($candidate)
  if (-not $absolute.StartsWith($workspace + "\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the workspace: $absolute"
  }
}

function Get-Sha256([string]$filePath) {
  $stream = [System.IO.File]::OpenRead($filePath)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return (($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "").ToUpperInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-VerifiedFile(
  [string]$url,
  [string]$destination,
  [string]$expectedSha256
) {
  Assert-WorkspaceChild $destination
  if (Test-Path -LiteralPath $destination) {
    $actual = Get-Sha256 $destination
    if ($actual -eq $expectedSha256) { return }
    Remove-Item -LiteralPath $destination -Force
  }

  $partial = "$destination.partial"
  if (Test-Path -LiteralPath $partial) {
    Remove-Item -LiteralPath $partial -Force
  }
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $partial
  $downloadedHash = Get-Sha256 $partial
  if ($downloadedHash -ne $expectedSha256) {
    Remove-Item -LiteralPath $partial -Force
    throw "SHA-256 mismatch for $url. Expected $expectedSha256, received $downloadedHash."
  }
  Move-Item -LiteralPath $partial -Destination $destination
}

function Remove-WorkspaceDirectory([string]$directory) {
  Assert-WorkspaceChild $directory
  if (Test-Path -LiteralPath $directory) {
    Remove-Item -LiteralPath $directory -Recurse -Force
  }
}

New-Item -ItemType Directory -Force -Path $cacheDirectory, $nativeDirectory | Out-Null

$streamlinkExecutable = Join-Path $streamlinkDirectory "bin\streamlink.exe"
$expectedManifest = [ordered]@{
  streamlink = $streamlinkVersion
  streamlinkFfmpeg = "omitted"
} | ConvertTo-Json

if (
  (Test-Path -LiteralPath $manifestPath) -and
  (Test-Path -LiteralPath $streamlinkExecutable) -and
  ((Get-Content -LiteralPath $manifestPath -Raw).Trim() -eq $expectedManifest.Trim())
) {
  Copy-Item -LiteralPath (Join-Path $workspace "third_party\NATIVE_RUNTIME_SOURCES.md") `
    -Destination (Join-Path $nativeDirectory "NATIVE_RUNTIME_SOURCES.md") -Force
  Copy-Item -LiteralPath (Join-Path $workspace "THIRD_PARTY_NOTICES.md") `
    -Destination (Join-Path $nativeDirectory "THIRD_PARTY_NOTICES.md") -Force
  Write-Host "Bundled Streamlink runtime is already prepared."
  exit 0
}

$streamlinkArchive = Join-Path $cacheDirectory $streamlinkArchiveName
Get-VerifiedFile $streamlinkUrl $streamlinkArchive $streamlinkSha256

$streamlinkStaging = Join-Path $nativeDirectory ".streamlink-staging"
Remove-WorkspaceDirectory $streamlinkStaging
Remove-WorkspaceDirectory $streamlinkDirectory
New-Item -ItemType Directory -Force -Path $streamlinkStaging, $streamlinkDirectory | Out-Null
Expand-Archive -LiteralPath $streamlinkArchive -DestinationPath $streamlinkStaging -Force
$streamlinkRoot = Get-ChildItem -LiteralPath $streamlinkStaging -Directory | Select-Object -First 1
if (-not $streamlinkRoot) {
  throw "The Streamlink portable archive did not contain its expected root directory."
}
Get-ChildItem -LiteralPath $streamlinkRoot.FullName -Force |
  Move-Item -Destination $streamlinkDirectory
Remove-WorkspaceDirectory $streamlinkStaging
# Chromium consumes HLS directly, so the optional FFmpeg muxer is unnecessary.
Remove-WorkspaceDirectory (Join-Path $streamlinkDirectory "ffmpeg")

Copy-Item -LiteralPath (Join-Path $workspace "third_party\NATIVE_RUNTIME_SOURCES.md") `
  -Destination (Join-Path $nativeDirectory "NATIVE_RUNTIME_SOURCES.md") -Force
Copy-Item -LiteralPath (Join-Path $workspace "THIRD_PARTY_NOTICES.md") `
  -Destination (Join-Path $nativeDirectory "THIRD_PARTY_NOTICES.md") -Force

if (-not (Test-Path -LiteralPath $streamlinkExecutable)) {
  throw "Streamlink extraction completed without bin\streamlink.exe."
}

Set-Content -LiteralPath $manifestPath -Value $expectedManifest -Encoding utf8
Write-Host "Prepared Streamlink $streamlinkVersion."
