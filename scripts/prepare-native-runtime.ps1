$ErrorActionPreference = "Stop"

$streamlinkVersion = "8.4.0-1"
$streamlinkArchiveName = "streamlink-8.4.0-1-py314-x86_64.zip"
$streamlinkUrl = "https://github.com/streamlink/windows-builds/releases/download/8.4.0-1/$streamlinkArchiveName"
$streamlinkSha256 = "A8D3BD2B409E6D1B1F7A0E2A5C0CBFBA619775E475DA3F31285AF08D680FB71C"

$mpvVersion = "20260610-git-304426c"
$mpvDevArchiveName = "mpv-dev-x86_64-20260610-git-304426c.7z"
$mpvDevUrl = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20260610/$mpvDevArchiveName"
$mpvDevSha256 = "8CBB25EA784F01AFBB3F904217CAB1317430A8BCFD5680FD827A866367F71CC9"

$mpvLicenseFiles = @(
  @{
    Name = "Copyright"
    Url = "https://raw.githubusercontent.com/mpv-player/mpv/304426c39/Copyright"
    Sha256 = "BFE9EE4CCEABCB8ECBFADF208D04156F73D801E6A57369A5606BB8341E204A23"
  },
  @{
    Name = "LICENSE.GPL"
    Url = "https://raw.githubusercontent.com/mpv-player/mpv/304426c39/LICENSE.GPL"
    Sha256 = "EDAEF632CBB643E4E7A221717A6C441A4C1A7C918E6E4D56DEBC3D8739B233F6"
  },
  @{
    Name = "LICENSE.LGPL"
    Url = "https://raw.githubusercontent.com/mpv-player/mpv/304426c39/LICENSE.LGPL"
    Sha256 = "72B672113D642CBB8EF5DCC76938DB801983C56E50B1400AB930F1A64D6DC8D9"
  }
)

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$cacheDirectory = Join-Path $workspace ".cache\native-runtime"
$nativeDirectory = Join-Path $workspace "vendor\native"
$streamlinkDirectory = Join-Path $nativeDirectory "streamlink"
$mpvDevDirectory = Join-Path $nativeDirectory "mpv-dev"
$manifestPath = Join-Path $nativeDirectory "versions.json"
$sevenZip = Join-Path $workspace "node_modules\7zip-bin\win\x64\7za.exe"

function Assert-WorkspaceChild([string]$candidate) {
  $absolute = [System.IO.Path]::GetFullPath($candidate)
  if (-not $absolute.StartsWith($workspace + "\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the workspace: $absolute"
  }
}

function Get-Sha256([string]$filePath) {
  $stream = [System.IO.File]::OpenRead($filePath)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
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
    if ($actual -eq $expectedSha256) {
      return
    }
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
$mpvHeader = Join-Path $mpvDevDirectory "include\mpv\client.h"
$libmpvDll = Join-Path $mpvDevDirectory "libmpv-2.dll"
$expectedManifest = [ordered]@{
  streamlink = $streamlinkVersion
  streamlinkFfmpeg = "omitted"
  mpvDev = $mpvVersion
} | ConvertTo-Json

if (
  (Test-Path -LiteralPath $manifestPath) -and
  (Test-Path -LiteralPath $streamlinkExecutable) -and
  (Test-Path -LiteralPath $mpvHeader) -and
  (Test-Path -LiteralPath $libmpvDll) -and
  ((Get-Content -LiteralPath $manifestPath -Raw).Trim() -eq $expectedManifest.Trim())
) {
  Copy-Item -LiteralPath (Join-Path $workspace "third_party\NATIVE_RUNTIME_SOURCES.md") `
    -Destination (Join-Path $nativeDirectory "NATIVE_RUNTIME_SOURCES.md") -Force
  Copy-Item -LiteralPath (Join-Path $workspace "THIRD_PARTY_NOTICES.md") `
    -Destination (Join-Path $nativeDirectory "THIRD_PARTY_NOTICES.md") -Force
  Write-Host "Bundled native runtime is already prepared."
  exit 0
}

if (-not (Test-Path -LiteralPath $sevenZip)) {
  throw "7zip-bin is missing. Run npm install before preparing the native runtime."
}

$streamlinkArchive = Join-Path $cacheDirectory $streamlinkArchiveName
$mpvDevArchive = Join-Path $cacheDirectory $mpvDevArchiveName

Get-VerifiedFile $streamlinkUrl $streamlinkArchive $streamlinkSha256
Get-VerifiedFile $mpvDevUrl $mpvDevArchive $mpvDevSha256

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
# Twitch HLS playback does not require Streamlink's optional FFmpeg muxer.
# mpv decodes the HLS input, so omitting this duplicate saves roughly 200 MB.
Remove-WorkspaceDirectory (Join-Path $streamlinkDirectory "ffmpeg")

Remove-WorkspaceDirectory $mpvDevDirectory
New-Item -ItemType Directory -Force -Path $mpvDevDirectory | Out-Null
& $sevenZip x $mpvDevArchive "-o$mpvDevDirectory" -y | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "7-Zip could not extract the mpv development archive."
}

$mpvLicensesDirectory = Join-Path $mpvDevDirectory "licenses"
New-Item -ItemType Directory -Force -Path $mpvLicensesDirectory | Out-Null
foreach ($license in $mpvLicenseFiles) {
  Get-VerifiedFile $license.Url (Join-Path $mpvLicensesDirectory $license.Name) $license.Sha256
}
Copy-Item -LiteralPath (Join-Path $workspace "third_party\NATIVE_RUNTIME_SOURCES.md") `
  -Destination (Join-Path $nativeDirectory "NATIVE_RUNTIME_SOURCES.md") -Force
Copy-Item -LiteralPath (Join-Path $workspace "THIRD_PARTY_NOTICES.md") `
  -Destination (Join-Path $nativeDirectory "THIRD_PARTY_NOTICES.md") -Force

if (-not (Test-Path -LiteralPath $streamlinkExecutable)) {
  throw "Streamlink extraction completed without bin\streamlink.exe."
}
if (-not (Test-Path -LiteralPath $mpvHeader)) {
  throw "mpv development extraction completed without include\mpv\client.h."
}
if (-not (Test-Path -LiteralPath $libmpvDll)) {
  throw "mpv development extraction completed without libmpv-2.dll."
}

Set-Content -LiteralPath $manifestPath -Value $expectedManifest -Encoding utf8
Write-Host "Prepared Streamlink $streamlinkVersion and libmpv $mpvVersion."
