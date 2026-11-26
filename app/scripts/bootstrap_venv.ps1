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
$TotalSteps = 2
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

# The flat layout is only trusted once the marker at the very end of this script
# exists: python.exe is extracted within seconds, so on its own it would make an
# install interrupted halfway (window closed, crash, power cut) look complete
# and leave every later launch with a broken environment.
$markerPath = Join-Path $TargetDir ".bootstrap_complete"
if ((Test-Path (Join-Path $TargetDir "Scripts\python.exe")) -or
    ((Test-Path (Join-Path $TargetDir "python.exe")) -and (Test-Path $markerPath))) {
    Say "Python environment already present at $TargetDir -- nothing to do."
    exit 0
}
if (Test-Path $TargetDir) {
    Say "Removing an incomplete Python environment from an interrupted install..."
    Remove-Item -Recurse -Force $TargetDir
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

    # Python and uv are independent downloads: fetch both at once.
    Step 1 "Downloading Python $PythonVersion (~10 MB) and uv $UvVersion (~20 MB) in parallel..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $uvZipUrl = "https://github.com/astral-sh/uv/releases/download/$UvVersion/uv-x86_64-pc-windows-msvc.zip"
    $uvZipPath = Join-Path $tempDir "uv.zip"
    $wc1 = New-Object System.Net.WebClient
    $wc2 = New-Object System.Net.WebClient
    $dl1 = $wc1.DownloadFileTaskAsync($embedZipUrl, $embedZipPath)
    $dl2 = $wc2.DownloadFileTaskAsync($uvZipUrl, $uvZipPath)
    [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($dl1, $dl2))

    Say "Extracting Python to $TargetDir ..."
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Expand-Archive -Path $embedZipPath -DestinationPath $TargetDir -Force

    # The embeddable package ships with site-packages import disabled by
    # default (python*._pth has "import site" commented out) -- installed
    # packages would otherwise be invisible to the interpreter.
    $pthFile = Get-ChildItem -Path $TargetDir -Filter "python*._pth" | Select-Object -First 1
    if (-not $pthFile) {
        throw "Could not find the embeddable package's ._pth file under $TargetDir"
    }
    (Get-Content $pthFile.FullName) -replace '^#\s*import site', 'import site' | Set-Content $pthFile.FullName

    $pythonExe = Join-Path $TargetDir "python.exe"

    # uv (astral-sh/uv, a standalone Rust binary -- no Python/pip needed to run
    # it) installs everything, so pip itself is not installed at all: nothing
    # in the app uses it, and skipping get-pip saves a download and ~15 s.
    $uvDir = Join-Path $tempDir "uv"
    Expand-Archive -Path $uvZipPath -DestinationPath $uvDir -Force
    $uvExe = Get-ChildItem -Path $uvDir -Filter "uv.exe" -Recurse | Select-Object -First 1 -ExpandProperty FullName
    if (-not $uvExe) { throw "uv.exe not found after extracting $uvZipPath" }

    # The PyTorch wheel is one ~2.7 GB file on a single connection, which on
    # its own rarely saturates a fast line. Installing torch and every other
    # package in ONE uv run lets uv download the rest of the packages while the
    # big wheel is still coming in. torch/torchvision aren't in
    # requirements-frozen.txt on purpose: they need PyTorch's own CUDA build.
    # --find-links (not --extra-index-url) points uv at just the wheel list of
    # those two packages, so no other package can be picked up from the PyTorch
    # index by mistake. The "+cu128" local versions exist nowhere else.
    # torchaudio is deliberately NOT installed: nothing in the app imports it
    # and it is a ~1.7 GB download.
    $env:UV_HTTP_TIMEOUT = "600"   # slow lines: do not give up on the multi-GB wheel
    Step 2 "Installing PyTorch $TorchVersion ($CudaTag, ~3 GB) and all other packages in one go, several minutes..."
    $code = Invoke-WithHeartbeat $uvExe @(
        "pip", "install", "--python", $pythonExe,
        "torch==$TorchVersion+$CudaTag", "torchvision==$TorchvisionVersion+$CudaTag",
        "-r", $requirementsPath,
        "--find-links", "https://download.pytorch.org/whl/$CudaTag/torch/",
        "--find-links", "https://download.pytorch.org/whl/$CudaTag/torchvision/"
    ) "Package install" $uvCache
    if ($code -ne 0) {
        # Safety net: the older, slower but proven two-step route.
        Say "Combined install failed (exit $code), falling back to two separate installs..."
        $code = Invoke-WithHeartbeat $uvExe @(
            "pip", "install", "--python", $pythonExe,
            "torch==$TorchVersion+$CudaTag", "torchvision==$TorchvisionVersion+$CudaTag",
            "--index-url", "https://download.pytorch.org/whl/$CudaTag"
        ) "PyTorch install" $uvCache
        if ($code -ne 0) { throw "PyTorch install failed (exit $code)" }
        $code = Invoke-WithHeartbeat $uvExe @("pip", "install", "--python", $pythonExe, "-r", $requirementsPath) "Requirements install" $null
        if ($code -ne 0) { throw "requirements-frozen.txt install failed (exit $code)" }
    }

    New-Item -ItemType File -Path $markerPath -Force | Out-Null
    Say "Bootstrap complete: $TargetDir is a working Python environment."
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    if ($uvCache) { Remove-Item -Recurse -Force $uvCache -ErrorAction SilentlyContinue }
}
