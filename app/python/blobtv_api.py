#!/usr/bin/env python3
"""BlobTELEvision HTTP API: ModelScope text-to-video + I2VGen-XL image-to-video.

The Tauri shell (tauri/src-tauri/src/main.rs) spawns this as a child process
and the frontend (tauri/src/main.ts) calls it directly over HTTP.
"""
import argparse
import mimetypes
import os
import shutil
import sys
import threading
import time
import uuid
from typing import List, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# pythonw.exe (release builds) has no console, so sys.stdout/stderr can be
# None unless the Rust shell redirected them to a log file. Make print() safe.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

import blobtv_cancel
from blobtv_engine import (
    I2V_FORMATS,
    MODELS,
    T2V_FORMATS,
    GenParams,
    TelevisionEngine,
    download_model,
    model_status,
)
from blobtv_paths import MODELS_ROOT, outputs_dir, uploads_dir
import blobtv_post

API_PORT_DEFAULT = 8421

app = FastAPI(title="BlobTELEvision API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# "Fast reboot" (main.rs) can leave this process alive after the window closes
# so a later launch reconnects instead of paying the cold-load cost again. This
# is the safety net: with no request for 30 minutes, exit on our own.
_last_request_time = time.time()
_IDLE_TIMEOUT_SECONDS = 30 * 60


@app.middleware("http")
async def _track_activity(request, call_next):
    global _last_request_time
    _last_request_time = time.time()
    return await call_next(request)


def _idle_shutdown_watchdog():
    while True:
        time.sleep(60)
        if time.time() - _last_request_time > _IDLE_TIMEOUT_SECONDS:
            print("Idle for 30 min with no requests, shutting down.", flush=True)
            os._exit(0)


_engine = TelevisionEngine()

# Everything the install panel can fetch: the two diffusion models (Hugging Face)
# plus the optional Redux tools (Real-ESRGAN weights, RIFE binary).
def _status_of(key):
    if key == "esrgan":
        return blobtv_post.esrgan_status()
    if key == "rife":
        return blobtv_post.rife_status()
    return model_status(key)


def _download_of(key, on_progress):
    if key == "esrgan":
        return blobtv_post.download_esrgan(on_progress)
    if key == "rife":
        return blobtv_post.download_rife(on_progress)
    return download_model(key, on_progress=on_progress)


_ALL_KEYS = ("t2v", "i2v", "esrgan", "rife")

# Models currently downloading + their last progress line.
_install_lock = threading.Lock()
_installing = set()
_install_progress = {}


# --- jobs ---------------------------------------------------------------------

class Job:
    """One background generation. Renders take minutes, far too long to hold an
    HTTP request open, so /generate returns a job id the client polls."""

    def __init__(self, job_id: str):
        self.job_id = job_id
        self.state = "running"  # running | done | error | cancelled
        self.lines: List[str] = []
        self.step = 0
        self.total = 0
        self.phase = ""
        self.output_url: Optional[str] = None
        self.metadata: Optional[dict] = None
        self.error: Optional[str] = None
        self._lock = threading.Lock()

    def append(self, msg: str):
        with self._lock:
            self.lines.append(msg)
            if len(self.lines) > 200:
                self.lines = self.lines[-200:]
        print(msg, flush=True)

    def set_step(self, n: int, total: int):
        self.step, self.total = n, total

    def set_phase(self, name: str):
        # Each phase (denoise, upscale, interpolate) has its own step counter.
        self.phase = name
        self.step, self.total = 0, 0

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "job_id": self.job_id,
                "state": self.state,
                "lines": list(self.lines),
                "phase": self.phase,
                "step": self.step,
                "total": self.total,
                "output_url": self.output_url,
                "metadata": self.metadata,
                "error": self.error,
            }


_jobs = {}
_jobs_lock = threading.Lock()
_job_running = False


class GenerateRequest(BaseModel):
    kind: str = Field("t2v", pattern="^(t2v|i2v)$")
    prompt: str = ""
    negative_prompt: str = ""
    num_frames: int = Field(16, ge=4, le=64)
    fps: int = Field(8, ge=1, le=60)
    steps: int = Field(25, ge=1, le=100)
    guidance: float = Field(9.0, ge=1.0, le=30.0)
    seed: Optional[int] = None
    format: str = "256x256"
    # Redux (optional post-processing, see blobtv_post.py)
    upscale: str = Field("plain2", pattern="^(none|plain2|esrgan2|esrgan4)$")
    interp: int = Field(1, ge=1, le=4)
    upload_id: Optional[str] = None


# --- basic -----------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True}


@app.get("/favicon.ico")
def favicon():
    return JSONResponse(status_code=204, content=None)


@app.get("/status")
def status():
    return {**_engine.status(), "busy": _job_running}


@app.get("/formats")
def formats():
    return {
        "t2v": {k: {"width": w, "height": h} for k, (w, h) in T2V_FORMATS.items()},
        "i2v": {k: {"width": w, "height": h} for k, (w, h) in I2V_FORMATS.items()},
    }


# --- models ----------------------------------------------------------------

@app.get("/models/status")
def models_status():
    with _install_lock:
        installing = set(_installing)
        progress = dict(_install_progress)
    out = {}
    for key in _ALL_KEYS:
        s = _status_of(key)
        s["installing"] = key in installing
        s["progress"] = progress.get(key)
        out[key] = s
    return out


@app.post("/models/install")
def models_install(targets: List[str] = Body(..., embed=True)):
    """Fire-and-forget: one background thread per requested, not-yet-installed
    model. Poll /models/status for progress. Unknown names are ignored."""
    started = []
    for key in targets:
        if key not in _ALL_KEYS:
            continue
        with _install_lock:
            if key in _installing:
                continue
            _installing.add(key)
            _install_progress[key] = "Starting..."

        def run(key=key):
            try:
                _download_of(key, lambda msg, k=key: _install_progress.__setitem__(k, msg))
            except Exception as exc:
                _install_progress[key] = "Failed: {}".format(exc)
            finally:
                with _install_lock:
                    _installing.discard(key)

        threading.Thread(target=run, daemon=True).start()
        started.append(key)
    return {"ok": True, "installing": started}


@app.post("/models/uninstall")
def models_uninstall(targets: List[str] = Body(..., embed=True)):
    """Deletes the downloaded files of the requested models (a la carte). Refused
    while a generation or a download is running. A loaded model is unloaded first
    so Windows lets go of its memory-mapped weight files."""
    if _job_running:
        raise HTTPException(409, "A generation is running. Abort it or wait before uninstalling.")
    with _install_lock:
        busy = [k for k in targets if k in _installing]
    if busy:
        raise HTTPException(409, "Still downloading: {}.".format(", ".join(busy)))
    removed, errors = [], {}
    for key in targets:
        if key not in _ALL_KEYS:
            continue
        path = os.path.abspath(_status_of(key)["path"])
        # Only ever delete a direct child folder of models/ (never models/ itself, never elsewhere).
        if os.path.dirname(path) != os.path.abspath(MODELS_ROOT):
            errors[key] = "Refusing to delete unexpected path {}".format(path)
            continue
        if key in MODELS and _engine.status()["loaded"] == key:
            _engine.unload()
        if key == "esrgan":
            _engine._upscaler = blobtv_post.Upscaler()
        try:
            if os.path.isdir(path):
                shutil.rmtree(path)
            with _install_lock:
                _install_progress.pop(key, None)
            removed.append(key)
        except Exception as exc:
            errors[key] = "{}: {}".format(type(exc).__name__, exc)
    return {"ok": not errors, "removed": removed, "errors": errors}


@app.post("/warmup")
def warmup(kind: str = Body("t2v", embed=True)):
    """Loads a model in the background (so the first Generate isn't a cold
    load). Returns immediately; /status shows `loading` / `loaded`."""
    if kind not in MODELS:
        raise HTTPException(400, "Unknown model")
    if not model_status(kind)["ready"]:
        return {"ok": False, "reason": "{} weights are not installed.".format(MODELS[kind]["label"])}
    st = _engine.status()
    if st["loaded"] == kind or st["loading"]:
        return {"ok": True}

    def run():
        try:
            _engine.ensure_loaded(kind, on_progress=lambda m: print(m, flush=True))
        except Exception as exc:
            print("Warmup failed: {}: {}".format(type(exc).__name__, exc), flush=True)

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True}


@app.post("/shutdown")
def shutdown():
    """Lets the desktop shell stop an engine it did not start itself (one kept
    alive by a previous 'Fast reboot' session) when the user closes the app with
    Fast reboot turned off. Exits shortly after answering."""
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


@app.post("/priority/normal")
def priority_normal():
    # Kept for frontend compatibility with the BlobVision shell; nothing to do.
    return {"ok": True}


# --- generation -------------------------------------------------------------

@app.post("/upload")
async def upload(image: UploadFile = File(...)):
    """Stores the i2v source image and returns an id for /generate."""
    ext = os.path.splitext(image.filename or "")[1].lower()
    if ext not in (".png", ".jpg", ".jpeg", ".webp", ".bmp"):
        ext = ".png"
    upload_id = uuid.uuid4().hex
    path = os.path.join(uploads_dir(), upload_id + ext)
    with open(path, "wb") as fh:
        shutil.copyfileobj(image.file, fh)
    return {"upload_id": upload_id}


def _find_upload(upload_id: str) -> Optional[str]:
    safe = os.path.basename(upload_id or "")
    if not safe:
        return None
    for name in os.listdir(uploads_dir()):
        if os.path.splitext(name)[0] == safe:
            return os.path.join(uploads_dir(), name)
    return None


@app.post("/generate")
def generate(req: GenerateRequest):
    global _job_running
    if not req.prompt.strip() and req.kind == "t2v":
        raise HTTPException(400, "Write a prompt first.")
    formats = T2V_FORMATS if req.kind == "t2v" else I2V_FORMATS
    if req.format not in formats:
        raise HTTPException(400, "Unknown format {}".format(req.format))
    width, height = formats[req.format]
    init_path = None
    if req.kind == "i2v":
        init_path = _find_upload(req.upload_id or "")
        if not init_path:
            raise HTTPException(400, "Image-to-video needs a source image.")
    if not model_status(req.kind)["ready"]:
        raise HTTPException(409, "{} weights are not installed.".format(MODELS[req.kind]["label"]))
    if req.upscale.startswith("esrgan") and not blobtv_post.esrgan_status()["ready"]:
        raise HTTPException(409, "Real-ESRGAN is not installed. Use 'Install redux tools' first.")
    if req.interp > 1 and not blobtv_post.rife_status()["ready"]:
        raise HTTPException(409, "RIFE is not installed. Use 'Install redux tools' first.")

    with _jobs_lock:
        if _job_running:
            raise HTTPException(409, "A generation is already running.")
        _job_running = True
        job = Job(uuid.uuid4().hex)
        _jobs[job.job_id] = job

    params = GenParams(
        kind=req.kind,
        prompt=req.prompt.strip(),
        negative_prompt=req.negative_prompt.strip(),
        num_frames=req.num_frames,
        fps=req.fps,
        steps=req.steps,
        guidance=req.guidance,
        seed=req.seed,
        width=width,
        height=height,
        upscale=req.upscale,
        interp=req.interp,
        init_image_path=init_path,
    )

    def run():
        global _job_running
        try:
            result = _engine.generate(
                params, on_progress=job.append, on_step=job.set_step, on_phase=job.set_phase
            )
            job.output_url = "/outputs/" + result["filename"]
            job.metadata = result["metadata"]
            job.state = "done"
            job.append("Done: " + result["filename"])
        except blobtv_cancel.AbortedError:
            job.state = "cancelled"
            job.append("Aborted.")
        except Exception as exc:
            job.state = "error"
            job.error = "{}: {}".format(type(exc).__name__, exc)
            job.append("Failed: " + job.error)
        finally:
            with _jobs_lock:
                _job_running = False
            # CUDA OOM and friends can leave allocator junk behind.
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass

    threading.Thread(target=run, daemon=True).start()
    return {"ok": True, "job_id": job.job_id}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "Unknown job")
    return job.snapshot()


@app.post("/cancel")
def cancel():
    blobtv_cancel.request()
    return {"ok": True}


# --- outputs ----------------------------------------------------------------

@app.get("/outputs/recent")
def outputs_recent(limit: int = 60):
    """Most recent videos, newest first. Registered before /outputs/{filename}
    on purpose: FastAPI matches in registration order, and the catch-all would
    otherwise swallow 'recent'."""
    d = outputs_dir()
    entries = []
    for name in os.listdir(d):
        if not name.lower().endswith(".mp4"):
            continue
        path = os.path.join(d, name)
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            entries.append((os.path.getmtime(path), name))
    entries.sort(reverse=True)
    return [{"filename": n, "output_url": "/outputs/" + n} for _m, n in entries[:limit]]


@app.get("/outputs/{filename}")
def get_output(filename: str):
    safe = os.path.basename(filename)
    path = os.path.join(outputs_dir(), safe)
    if not os.path.isfile(path):
        raise HTTPException(404, "Not found")
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store"})


# --- entry point -------------------------------------------------------------

def _sweep_uploads_on_exit():
    try:
        for name in os.listdir(uploads_dir()):
            path = os.path.join(uploads_dir(), name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
    except Exception:
        pass


def parse_args():
    p = argparse.ArgumentParser(description="BlobTELEvision API server")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=API_PORT_DEFAULT)
    p.add_argument("--no-warmup", action="store_true", help="do not preload text-to-video at startup")
    return p.parse_args()


def _prefetch_model_files(model_dir):
    """Reads the fp16 weight files once so they sit in the OS file cache. Meant to
    run in threads next to the Python imports: file reads release the GIL, so on a
    cold start (after a reboot) the disk and the CPU work at the same time instead
    of one after the other. A no-op in effect when the files are already cached."""
    try:
        for root, _dirs, files in os.walk(model_dir):
            for name in files:
                if name.endswith(".fp16.safetensors"):
                    with open(os.path.join(root, name), "rb") as fh:
                        while fh.read(16 * 1024 * 1024):
                            pass
    except Exception:
        pass


def _preload_default_model():
    """Loads text-to-video as soon as the engine is up, instead of waiting for the
    window to ask: the multi-second torch/diffusers import and the model load then
    overlap with the window opening, and the first generation is instant."""
    time.sleep(1.0)  # let uvicorn start answering /health first
    try:
        if not model_status("t2v")["ready"]:
            return
        # One reader thread per weight file, running while this thread imports torch.
        for sub in ("unet", "text_encoder", "vae"):
            threading.Thread(
                target=_prefetch_model_files, args=(os.path.join(MODELS["t2v"]["dir"], sub),), daemon=True
            ).start()
        _engine.ensure_loaded("t2v", on_progress=lambda m: print(m, flush=True))
    except Exception as exc:
        print("Preload failed: {}: {}".format(type(exc).__name__, exc), flush=True)


def main():
    import atexit

    import uvicorn

    cli = parse_args()
    atexit.register(_sweep_uploads_on_exit)
    threading.Thread(target=_idle_shutdown_watchdog, daemon=True).start()
    if not cli.no_warmup:
        threading.Thread(target=_preload_default_model, daemon=True).start()
    print("BlobTELEvision API ready: http://{}:{}/docs".format(cli.host, cli.port), flush=True)
    uvicorn.run(app, host=cli.host, port=cli.port, log_level="info")


if __name__ == "__main__":
    main()
