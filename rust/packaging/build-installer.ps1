# Builds the VioletWire (Rust) installer and its update manifest:
#   rust\target\release\installer\VioletWire-Rust-Setup-<version>-x64.exe
#   rust\target\release\installer\violetwire-rust.json
# Needs Rust (MSVC) and Inno Setup 6. Streamlink comes from the same pinned,
# hash-checked build Electron uses (scripts\prepare-native-runtime.ps1).
$ErrorActionPreference = "Stop"

$rust = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$workspace = (Resolve-Path (Join-Path $rust "..")).Path

$cargoToml = Get-Content (Join-Path $rust "app\Cargo.toml") -Raw
$match = [regex]::Match($cargoToml, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $match.Success) { throw "Could not read the version from app\Cargo.toml." }
$version = $match.Groups[1].Value
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Unexpected version '$version'." }
Write-Host "VioletWire (Rust) $version"

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspace "scripts\prepare-native-runtime.ps1")
if ($LASTEXITCODE -ne 0) { throw "Preparing Streamlink failed." }

Push-Location $rust
try {
  & cargo build --release -p violetwire --locked
  if ($LASTEXITCODE -ne 0) { throw "cargo build failed." }
} finally {
  Pop-Location
}
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $rust "target" }
$buildDir = (Resolve-Path (Join-Path $targetDir "release")).Path

$iscc = @(
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) was not found." }

& $iscc "/DAppVersion=$version" "/DBuildDir=$buildDir" (Join-Path $PSScriptRoot "violetwire.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed." }

$installerName = "VioletWire-Rust-Setup-$version-x64.exe"
$installer = Join-Path $buildDir "installer\$installerName"
$sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{ version = $version; file = $installerName; sha256 = $sha256 } | ConvertTo-Json
Set-Content -LiteralPath (Join-Path $buildDir "installer\violetwire-rust.json") -Value $manifest -Encoding ascii
Write-Host "Built $installer"
Write-Host "SHA-256 $sha256"
