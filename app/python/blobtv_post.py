"""Optional "Redux" post-processing: push the tiny native output past what the
model can actually make, on purpose and without caring if it ends up ugly.

- Upscale: Real-ESRGAN x2 / x4 (the same family of upscaler TRACE-V uses),
  run through `spandrel` (a pure PyTorch loader) instead of the ncnn binary,
  so there is no extra exe to ship. Tiled, so VRAM stays bounded.
- Interpolation: RIFE (rife-ncnn-vulkan, same tool TRACE-V uses) to add
  frames and raise the frame rate.

Everything here is opt-in per generation. Like blobtv_engine, importing this
module must stay cheap: torch / spandrel are only imported inside functions.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from typing import Callable, List, Optional

import blobtv_cancel
from blobtv_paths import ESRGAN_DIR, RIFE_DIR, ensure_layout, work_dir

ensure_layout()

# Child processes of the windowless pythonw.exe would otherwise each flash a
# console window.
_NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

ESRGAN_FILES = {
    2: (
        "RealESRGAN_x2plus.pth",
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    ),
    4: (
        "RealESRGAN_x4plus.pth",
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    ),
}
RIFE_URL = (
    "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/"
    "rife-ncnn-vulkan-20221029-windows.zip"
)
MIN_WEIGHTS_BYTES = 1024 * 1024
_RIFE_EXE = "rife-ncnn-vulkan.exe"
# Preference order; v4 models are the only ones that can hit an arbitrary
# target frame count (-n), which is how x4 is done in a single pass.
_RIFE_MODELS = ("rife-v4.6", "rife-v4", "rife-v2.3", "rife-v2")


# --- status / install ---------------------------------------------------------

def esrgan_status() -> dict:
    ready = all(
        os.path.isfile(os.path.join(ESRGAN_DIR, name))
        and os.path.getsize(os.path.join(ESRGAN_DIR, name)) >= MIN_WEIGHTS_BYTES
        for name, _url in ESRGAN_FILES.values()
    )
    return {"ready": ready, "path": ESRGAN_DIR, "label": "Real-ESRGAN upscaler x2 + x4", "size_gb": 0.14}


def _rife_models_present() -> Optional[str]:
    for name in _RIFE_MODELS:
        if os.path.isfile(os.path.join(RIFE_DIR, name, "flownet.param")):
            return name
    return None


def rife_status() -> dict:
    ready = os.path.isfile(os.path.join(RIFE_DIR, _RIFE_EXE)) and _rife_models_present() is not None
    return {"ready": ready, "path": RIFE_DIR, "label": "RIFE frame interpolation", "size_gb": 0.43}


def _download(url: str, dest: str, label: str, on_progress: Optional[Callable[[str], None]]):
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "BlobTELEvision"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        got = 0
        last = 0.0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            got += len(chunk)
            if on_progress and time.time() - last > 1.0:
                last = time.time()
                if total:
                    on_progress("Downloading {} ({:.0f} / {:.0f} MB)".format(label, got / 1e6, total / 1e6))
                else:
                    on_progress("Downloading {} ({:.0f} MB)".format(label, got / 1e6))
    os.replace(tmp, dest)


def download_esrgan(on_progress: Optional[Callable[[str], None]] = None) -> dict:
    os.makedirs(ESRGAN_DIR, exist_ok=True)
    for scale, (name, url) in ESRGAN_FILES.items():
        path = os.path.join(ESRGAN_DIR, name)
        if os.path.isfile(path) and os.path.getsize(path) >= MIN_WEIGHTS_BYTES:
            continue
        _download(url, path, "Real-ESRGAN x{}".format(scale), on_progress)
    if on_progress:
        on_progress("Done.")
    return esrgan_status()


def download_rife(on_progress: Optional[Callable[[str], None]] = None) -> dict:
    if sys.platform != "win32":
        raise RuntimeError("Automatic RIFE download is Windows-only.")
    os.makedirs(RIFE_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="blobtv_rife_")
    try:
        zip_path = os.path.join(tmp, "rife.zip")
        _download(RIFE_URL, zip_path, "RIFE", on_progress)
        if on_progress:
            on_progress("Extracting RIFE...")
        with zipfile.ZipFile(zip_path) as zf:
            for member in zf.namelist():
                if member.endswith("/"):
                    continue
                parts = [p for p in member.replace("\\", "/").split("/") if p]
                # The archive wraps everything in rife-ncnn-vulkan-<date>-windows/.
                if parts and parts[0].lower().startswith("rife-ncnn") and len(parts) > 1:
                    parts = parts[1:]
                dest = os.path.join(RIFE_DIR, *parts)
                # Refuse path traversal out of RIFE_DIR (zip-slip).
                if not os.path.abspath(dest).startswith(os.path.abspath(RIFE_DIR) + os.sep):
                    continue
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(member) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # The archive ships ~10 models; only rife-v4.6 is used (the one that can hit
    # an arbitrary frame count in a single pass). Keep disk usage down.
    if os.path.isfile(os.path.join(RIFE_DIR, "rife-v4.6", "flownet.param")):
        for name in os.listdir(RIFE_DIR):
            path = os.path.join(RIFE_DIR, name)
            if name != "rife-v4.6" and os.path.isfile(os.path.join(path, "flownet.param")):
                shutil.rmtree(path, ignore_errors=True)
    if not rife_status()["ready"]:
        raise RuntimeError("RIFE was extracted but no usable model folder was found in " + RIFE_DIR)
    if on_progress:
        on_progress("Done.")
    return rife_status()


# --- Real-ESRGAN ----------------------------------------------------------------

class Upscaler:
    """Real-ESRGAN via spandrel. One loaded model per scale, cached."""

    def __init__(self):
        self._models = {}

    def _model(self, scale: int):
        if scale in self._models:
            return self._models[scale]
        import torch
        from spandrel import ModelLoader

        name, _url = ESRGAN_FILES[scale]
        path = os.path.join(ESRGAN_DIR, name)
        if not os.path.isfile(path):
            raise RuntimeError("Real-ESRGAN weights are not installed (Install redux tools).")
        model = ModelLoader().load_from_file(path)
        model = model.to(torch.device("cuda" if torch.cuda.is_available() else "cpu")).eval()
        self._models[scale] = model
        return model

    def free(self):
        self._models.clear()

    def upscale_frames(self, frames, scale: int, on_step: Optional[Callable[[int, int], None]] = None):
        """frames: (N, H, W, 3) uint8 array. Returns the upscaled (N, H*s, W*s, 3)."""
        import numpy as np
        import torch

        model = self._model(scale)
        device = next(model.model.parameters()).device
        out = []
        for i, frame in enumerate(frames):
            if blobtv_cancel.is_requested():
                raise blobtv_cancel.AbortedError("Aborted")
            t = torch.from_numpy(np.ascontiguousarray(frame)).permute(2, 0, 1).float().div(255.0)
            t = t.unsqueeze(0).to(device)
            with torch.no_grad():
                res = _tiled(model, t, scale)
            arr = (res.clamp(0, 1).squeeze(0).permute(1, 2, 0).cpu().numpy() * 255.0).round().astype("uint8")
            out.append(arr)
            if on_step:
                on_step(i + 1, len(frames))
        return np.stack(out)


def _tiled(model, img, scale: int, tile: int = 256, pad: int = 16):
    """Runs the model tile by tile (with `pad` px of context around each tile,
    cropped away afterwards) so peak VRAM does not grow with frame size."""
    import torch

    _b, _c, h, w = img.shape
    if h <= tile and w <= tile:
        return model(img)
    out = torch.zeros((1, 3, h * scale, w * scale), device=img.device, dtype=img.dtype)
    for y in range(0, h, tile):
        for x in range(0, w, tile):
            y0, y1 = max(y - pad, 0), min(y + tile + pad, h)
            x0, x1 = max(x - pad, 0), min(x + tile + pad, w)
            res = model(img[:, :, y0:y1, x0:x1])
            th, tw = min(tile, h - y), min(tile, w - x)
            oy, ox = (y - y0) * scale, (x - x0) * scale
            out[:, :, y * scale : (y + th) * scale, x * scale : (x + tw) * scale] = res[
                :, :, oy : oy + th * scale, ox : ox + tw * scale
            ]
    return out


# --- RIFE -----------------------------------------------------------------------

def interpolate_rife(
    frames,
    factor: int,
    on_progress: Optional[Callable[[str], None]] = None,
    on_step: Optional[Callable[[int, int], None]] = None,
):
    """frames: (N, H, W, 3) uint8. Returns (M, H, W, 3) with M = N*factor - (factor-1),
    i.e. real frames are kept and `factor - 1` new ones are inserted between
    each pair (the clip does not loop back on itself)."""
    import numpy as np
    from PIL import Image

    exe = os.path.join(RIFE_DIR, _RIFE_EXE)
    model = _rife_models_present()
    if not os.path.isfile(exe) or model is None:
        raise RuntimeError("RIFE is not installed (Install redux tools).")
    n_in = len(frames)
    if n_in < 2 or factor < 2:
        return frames
    target = n_in * factor - (factor - 1)

    job = tempfile.mkdtemp(prefix="rife_", dir=work_dir())
    in_dir = os.path.join(job, "in")
    out_dir = os.path.join(job, "out")
    os.makedirs(in_dir)
    os.makedirs(out_dir)
    try:
        for i, f in enumerate(frames):
            Image.fromarray(np.ascontiguousarray(f)).save(os.path.join(in_dir, "{:08d}.png".format(i)))

        def run_pass(src, dst, extra_args):
            cmd = [exe, "-i", src, "-o", dst, "-m", model, "-f", "out_%06d.png"] + extra_args
            proc = subprocess.Popen(
                cmd, cwd=RIFE_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **_NO_WINDOW
            )
            expected = int(extra_args[1]) if extra_args else n_in * 2 - 1
            while proc.poll() is None:
                if blobtv_cancel.is_requested():
                    proc.kill()
                    proc.wait()
                    raise blobtv_cancel.AbortedError("Aborted")
                if on_step:
                    on_step(min(len(os.listdir(dst)), expected), expected)
                time.sleep(0.3)
            output = proc.stdout.read() if proc.stdout else ""
            if proc.returncode != 0:
                tail = " | ".join(output.strip().splitlines()[-3:])
                raise RuntimeError("RIFE failed (exit {}): {}".format(proc.returncode, tail))

        if model.startswith("rife-v4"):
            run_pass(in_dir, out_dir, ["-n", str(target)])
        else:
            # Older models only double. Chain passes until we have enough frames.
            src = in_dir
            passes = 1 if factor == 2 else 2
            for k in range(passes):
                dst = out_dir if k == passes - 1 else os.path.join(job, "mid{}".format(k))
                os.makedirs(dst, exist_ok=True)
                run_pass(src, dst, [])
                src = dst

        files = sorted(f for f in os.listdir(out_dir) if f.lower().endswith(".png"))
        if not files:
            raise RuntimeError("RIFE produced no frames.")
        if on_progress:
            on_progress("RIFE: {} -> {} frames.".format(n_in, len(files)))
        return np.stack([np.asarray(Image.open(os.path.join(out_dir, f)).convert("RGB")) for f in files])
    finally:
        shutil.rmtree(job, ignore_errors=True)
