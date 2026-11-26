"""Central path layout for BlobTELEvision (portable, repo-relative).

Everything resolves from this file's own location, never from the current
working directory, so the app works from whatever folder it was copied or
installed to.
"""
import os
import re
import shutil
import threading
from datetime import datetime

_PY_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(_PY_DIR)
ROOT = os.path.dirname(APP_DIR)

MODELS_ROOT = os.path.join(ROOT, "models")
OUTPUTS_ROOT = os.path.join(ROOT, "outputs")

# Ephemeral per-job scratch space, a sibling of outputs/ so outputs/ only ever
# holds finished renders. Swept once per process at startup (see ensure_layout).
WORK_ROOT = os.path.join(ROOT, "work")

# Diffusers-format weights. One folder per model, see blobtv_engine.MODELS.
T2V_MODEL_DIR = os.path.join(MODELS_ROOT, "modelscope-t2v")
I2V_MODEL_DIR = os.path.join(MODELS_ROOT, "i2vgen-xl")

# Optional "Redux" post-processing tools (see blobtv_post.py).
ESRGAN_DIR = os.path.join(MODELS_ROOT, "upscale")
RIFE_DIR = os.path.join(MODELS_ROOT, "rife")

_work_dir_swept = False


def ensure_layout():
    os.makedirs(MODELS_ROOT, exist_ok=True)
    os.makedirs(outputs_dir(), exist_ok=True)
    os.makedirs(uploads_dir(), exist_ok=True)
    os.makedirs(WORK_ROOT, exist_ok=True)

    # Once per process, not once per call: lazily imported modules call this
    # at import time, and a mid-session re-sweep would delete an active job's
    # scratch files out from under it.
    global _work_dir_swept
    if not _work_dir_swept:
        _work_dir_swept = True
        for name in os.listdir(WORK_ROOT):
            path = os.path.join(WORK_ROOT, name)
            try:
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
            except OSError:
                pass


def outputs_dir():
    return OUTPUTS_ROOT


def uploads_dir():
    return os.path.join(OUTPUTS_ROOT, "uploads")


def work_dir():
    return WORK_ROOT


_naming_lock = threading.Lock()


def sanitize_basename(text, max_len=40):
    text = os.path.splitext(text or "")[0].strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return (text or "output")[:max_len]


def build_output_name(type_tag, basename_source, ext):
    """YYMMDD_TYPE_NNN_BASENAME.EXT, where NNN is the next free counter for
    (date, type_tag) in outputs/. Scanned off disk, so it survives restarts.
    The slot is reserved immediately with an empty placeholder file."""
    date_str = datetime.now().strftime("%y%m%d")
    basename = sanitize_basename(basename_source)
    prefix = "{}_{}_".format(date_str, type_tag)
    with _naming_lock:
        os.makedirs(OUTPUTS_ROOT, exist_ok=True)
        max_n = 0
        for name in os.listdir(OUTPUTS_ROOT):
            if not name.startswith(prefix):
                continue
            num = name[len(prefix):].split("_", 1)[0]
            if num.isdigit():
                max_n = max(max_n, int(num))
        filename = "{}{:03d}_{}{}".format(prefix, max_n + 1, basename, ext)
        path = os.path.join(OUTPUTS_ROOT, filename)
        try:
            os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            pass
    return filename
