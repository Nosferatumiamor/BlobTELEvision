# Bootstraps a working Python environment from scratch on a machine that has
# never run BlobTELEvision before -- no system Python, no venv, nothing. This is
# what makes the app installable on someone else's machine instead of only
# working here where a virtualenv-created venv/ already exists (that venv's
# own python.exe is NOT relocatable -- see tauri/src-tauri/src/main.rs's
# repo_root() comments for the exact reason this session already ran into).
#
# Produces a FLAT-layout venv/ (python.exe and pythonw.exe directly under
# venv/, not venv/Scripts/) using Python's own official "embeddable package"
# distribution, which is specifically built to be relocatable -- unlike a
# regular venv/virtualenv. Scripts/ still ends up existing underneath it
# (pip and other console-script entry points land there once installed),
# but the interpreter itself does not, which is why main.rs checks BOTH
# venv/python.exe (this layout) and venv/Scripts/python.exe (the existing
# dev machine's virtualenv layout) rather than assuming one or the other.
#
# Run manually to test in isolation: powershell -File bootstrap_venv.ps1 -TargetDir <path>
# The real caller (main.rs) points -TargetDir at the real venv/ when it's missing.

param(
    [string]$TargetDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "venv"),
    [string]$PythonVersion = "3.10.11",
    # torch and torchvision use independent version numbers (0.26.0
    # alongside torch 2.11.0 here) -- came straight off the real working
    # venv's own `pip freeze`, not guessed.
    [string]$TorchVersion = "2.11.0",
    [string]$TorchvisionVersion = "0.26.0",
    [string]$CudaTag = "cu128",
    # Pinned rather than queried from GitHub's "latest release" API at
    # bootstrap time: that API is rate-limited (60 unauthenticated
    # requests/hour/IP) and one more moving part on the one path that
    # absolutely must not hang or fail for a first-time user. Bump by hand
    # when there's a reason to.
    [string]$UvVersion = "0.12.13"
)

$ErrorActionPreference = "Stop"

function Say($msg) {
    Write-Host "[bootstrap] $msg"
    # Explicit flush: when stdout is redirected to a file (as main.rs does,
    # for the live in-app console — see read_bootstrap_log), Write-Host's
    # output can otherwise sit in a buffer instead of reaching disk
    # immediately. Without this, a hang or crash a few steps later can
    # leave the log looking completely empty even though several stages
    # actually completed, which is exactly the kind of "is it even doing
    # anything?" situation this log exists to prevent.
    [Console]::Out.Flush()
}

# Step markers are parsed by the app (tauri/src/main.ts, parseBootstrapStep) to
# drive the progress bar in the output frame, so keep the "[n/N]" format.
$TotalSteps = 5
function Step($n, $msg) {
    Say "[$n/$TotalSteps] $msg"
}

# Runs a native command and prints a heartbeat line every few seconds while it
# works. uv hides its own progress bars when stdout is redirected to a file, so
# without this the multi-GB steps look frozen for many minutes. $WatchDir (uv's
# cache) is measured to show real download progress.
function Invoke-WithHeartbeat($exe, [string[]]$argList, $label, $WatchDir) {
    $quoted = $argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $p = Start-Process -FilePath $exe -ArgumentList ($quoted -join ' ') -NoNewWindow -PassThru
    $null = $p.Handle  # keeps the handle so ExitCode is readable after exit
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $p.WaitForExit(10000)) {
        $info = ""
        if ($WatchDir -and (Test-Path $WatchDir)) {
            $bytes = (Get-ChildItem $WatchDir -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
            if ($bytes) { $info = (" - {0:n2} GB downloaded so far" -f ($bytes / 1GB)) }
        }
        Say ("    ... {0} still running ({1:mm\:ss} elapsed){2}" -f $label, $sw.Elapsed, $info)
    }
    return $p.ExitCode
}

if ((Test-Path (Join-Path $TargetDir "python.exe")) -or (Test-Path (Join-Path $TargetDir "Scripts\python.exe"))) {
    Say "Python environment already present at $TargetDir -- nothing to do."
    exit 0
}

$scriptRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $scriptRoot)
$requirementsPath = Join-Path $repoRoot "app\requirements-frozen.txt"
if (-not (Test-Path $requirementsPath)) {
    throw "Missing $requirementsPath -- can't bootstrap without the frozen package list."
}

$tempDir = Join-Path $env:TEMP ("blobtelevision-bootstrap-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
try {
    $embedZipUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
    $embedZipPath = Join-Path $tempDir "python-embed.zip"
    # uv's package cache lives next to the venv (same volume) instead of the
    # global %LOCALAPPDATA%\uv\cache: that avoids the "failed to hardlink,
    # falling back to full copy" warning, avoids storing every package twice,
    # and is deleted at the end so it leaves nothing behind.
    $uvCache = Join-Path (Split-Path -Parent $TargetDir) ".uv-cache"
    $env:UV_CACHE_DIR = $uvCache

    Step 1 "Downloading Python $PythonVersion (embeddable, ~10 MB) from python.org..."
    Invoke-WebRequest -Uri $embedZipUrl -OutFile $embedZipPath -UseBasicParsing -TimeoutSec 120

    Say "Extracting to $TargetDir ..."
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Expand-Archive -Path $embedZipPath -DestinationPath $TargetDir -Force

    # The embeddable package ships with site-packages import disabled by
    # default (python*._pth has "import site" commented out) -- pip and any
    # installed package would otherwise be invisible to the interpreter.
    $pthFile = Get-ChildItem -Path $TargetDir -Filter "python*._pth" | Select-Object -First 1
    if (-not $pthFile) {
        throw "Could not find the embeddable package's ._pth file under $TargetDir"
    }
    Say "Enabling site-packages in $($pthFile.Name)..."
    (Get-Content $pthFile.FullName) -replace '^#\s*import site', 'import site' | Set-Content $pthFile.FullName

    $pythonExe = Join-Path $TargetDir "python.exe"

    Step 2 "Installing pip (downloading get-pip.py)..."
    $getPipPath = Join-Path $tempDir "get-pip.py"
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath -UseBasicParsing -TimeoutSec 60

    & $pythonExe $getPipPath --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw "get-pip.py failed (exit $LASTEXITCODE)" }

    # uv (astral-sh/uv, a standalone Rust binary -- no Python/pip needed to
    # run it) does the two big installs below instead of plain pip: it
    # downloads packages in parallel rather than one at a time, which is
    # the one lever that actually helps every first-time user regardless of
    # their disk speed (pip itself stays installed above as a harmless
    # fallback, in case anything downstream expects it importable, but
    # nothing here actually calls it again after this point).
    Step 3 "Downloading uv $UvVersion (parallel installer, ~20 MB)..."
    $uvZipUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
    $uvZipPath = Join-Path $tempDir "uv.zip"
    Invoke-WebRequest -Uri $uvZipUrl -OutFile $uvZipPath -UseBasicParsing -TimeoutSec 120
    $uvDir = Join-Path $tempDir "uv"
    Expand-Archive -Path $uvZipPath -DestinationPath $uvDir -Force
    $uvExe = Get-ChildItem -Path $uvDir -Filter "uv.exe" -Recurse | Select-Object -First 1 -ExpandProperty FullName
    if (-not $uvExe) { throw "uv.exe not found after extracting $uvZipPath" }

    # torch/torchvision aren't in requirements-frozen.txt on purpose -- they
    # need PyTorch's own CUDA-specific index, not plain PyPI, and the right
    # build depends on what this app already assumes about the target
    # machine (an NVIDIA GPU -- see resolve_sketch_full_gpu in
    # blobtv_engine.py, which has no real CPU-only path anyway).
    # torchaudio is deliberately NOT installed: nothing in the app imports
    # it (verified against the actual shipped code, not assumed) -- it was
    # only ever installed because it's what PyTorch's own docs tell you to
    # install alongside torch/torchvision, and it's a genuinely large
    # download (~1.7 GB) for zero runtime benefit here.
    Step 4 "Installing PyTorch $TorchVersion ($CudaTag build) -- this is the big one, ~3 GB download, several minutes..."
    $code = Invoke-WithHeartbeat $uvExe @(
        "pip", "install", "--python", $pythonExe,
        "torch==$TorchVersion+$CudaTag", "torchvision==$TorchvisionVersion+$CudaTag",
        "--index-url", "https://download.pytorch.org/whl/$CudaTag"
    ) "PyTorch install" $uvCache
    if ($code -ne 0) { throw "PyTorch install failed (exit $code)" }

    Step 5 "Installing the rest of the frozen requirements (diffusers, transformers, FastAPI...)..."
    $code = Invoke-WithHeartbeat $uvExe @("pip", "install", "--python", $pythonExe, "-r", $requirementsPath) "Requirements install" $null
    if ($code -ne 0) { throw "requirements-frozen.txt install failed (exit $code)" }

    Say "Bootstrap complete: $TargetDir is a working Python environment."
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    if ($uvCache) { Remove-Item -Recurse -Force $uvCache -ErrorAction SilentlyContinue }
}
