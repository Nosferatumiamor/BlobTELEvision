# Builds the release exe and the NSIS installer, without leaking anything about the build machine.
#
# What it takes care of (all of it was found by scanning a normal `tauri build`):
#   * rustc bakes absolute source paths (cargo registry under the user profile, the repo folder) into
#     the exe for panic messages, plus the PDB path. They are remapped to neutral names.
#   * `app/` is bundled as a resource and __pycache__ would be copied with it; .pyc files embed the
#     absolute path of their source. They are deleted first.
#   * At the end the exe and the bundled resources are scanned for the user name, the profile folder
#     and the repo folder (ASCII and UTF-16). The script fails if anything is found.
#
# Usage: Build-Installer.bat   (or: powershell -File Build-Installer.ps1)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$tauri = Join-Path $root "tauri"
$release = Join-Path $tauri "src-tauri\target\release"

function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }

Step "Cleaning compiled Python caches"
Get-ChildItem -Path (Join-Path $root "app") -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force

# Tauri copies resources over what is already in target\release, so stale files (old .pyc, old
# installers) from earlier builds would be bundled or scanned alongside the new ones.
Remove-Item -Recurse -Force (Join-Path $release "app") -ErrorAction SilentlyContinue
Get-ChildItem -Path (Join-Path $release "bundle\nsis") -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Remove-Item -Force

Step "Preparing the toolchain"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "Rust/Cargo not found. Install it from https://rustup.rs and try again."
}
# Later --remap-path-prefix flags win over earlier ones, so general first, specific last.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
$rustupHome = if ($env:RUSTUP_HOME) { $env:RUSTUP_HOME } else { Join-Path $env:USERPROFILE ".rustup" }
$flags = @(
    "--remap-path-prefix=$($env:USERPROFILE)=/home",
    "--remap-path-prefix=$rustupHome=/rustup",
    "--remap-path-prefix=$cargoHome=/cargo",
    "--remap-path-prefix=$root=/blobtelevision",
    "-Clink-arg=/PDBALTPATH:%_PDB%"
)
# CARGO_ENCODED_RUSTFLAGS is split on 0x1f, so paths containing spaces are safe.
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]0x1f

Step "Building (a few minutes the first time)"
Push-Location $tauri
try {
    if (-not (Test-Path "node_modules")) {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    }
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
    Pop-Location
}

Step "Scanning the build for personal information"
$needles = @($env:USERNAME, $env:USERPROFILE, $root) | Where-Object { $_ -and $_.Length -ge 4 } | Select-Object -Unique
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
$targets = @(Join-Path $release "blobtelevision.exe")
# The installer bundles the app folder of the repo (the copy in target/release/app is only a dev-time leftover).
$targets += Get-ChildItem -Path (Join-Path $root "app") -Recurse -File | ForEach-Object { $_.FullName }
$leaks = @()
foreach ($file in $targets) {
    $text = $latin1.GetString([System.IO.File]::ReadAllBytes($file))
    foreach ($n in $needles) {
        $utf16 = $latin1.GetString([System.Text.Encoding]::Unicode.GetBytes($n))
        if ($text.IndexOf($n, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
            $text.IndexOf($utf16, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $leaks += "$file contains '$n'"
        }
    }
}
if ($leaks.Count -gt 0) {
    $leaks | ForEach-Object { Write-Host "  LEAK: $_" -ForegroundColor Red }
    throw "Personal information found in the build, do not publish it."
}
Write-Host ("  clean ({0} files checked)" -f $targets.Count) -ForegroundColor Green

Step "Result"
Get-ChildItem -Path (Join-Path $release "bundle\nsis") -Filter "*-setup.exe" | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0}  {1:N1} MB" -f $_.FullName, ($_.Length / 1MB))
    Write-Host ("  SHA256 {0}" -f $hash)
}
