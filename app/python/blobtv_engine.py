"""BlobTELEvision engine: ModelScope text-to-video (damo-vilab, 1.7B) and
I2VGen-XL image-to-video, via diffusers.

Importing this module is cheap on purpose (no torch / diffusers at module
level): the API has to answer /health and /models/status instantly on a fresh
install, long before any weights exist. Heavy imports happen inside the
functions that need them.
"""
import gc
import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import blobtv_cancel
import blobtv_post
from blobtv_paths import (
    I2V_MODEL_DIR,
    T2V_MODEL_DIR,
    build_output_name,
    ensure_layout,
    outputs_dir,
)

ensure_layout()

COMPLETE_MARKER = ".blobtv_complete"

_COMMON_ALLOW = [
    "model_index.json",
    "scheduler/*",
    "tokenizer/*",
    "text_encoder/config.json",
    "text_encoder/model.fp16.safetensors",
    "unet/config.json",
    "unet/diffusion_pytorch_model.fp16.safetensors",
    "vae/config.json",
    "vae/diffusion_pytorch_model.fp16.safetensors",
]

# Only the diffusers-format fp16 safetensors are fetched. Both repos also host
# the original ModelScope .pth / .ckpt checkpoints and fp32 copies, which would
# multiply the download several times over for nothing.
MODELS = {
    "t2v": {
        "label": "ModelScope text-to-video (1.7B)",
        "repo": "damo-vilab/text-to-video-ms-1.7b",
        "dir": T2V_MODEL_DIR,
        "size_gb": 3.7,
        "allow": list(_COMMON_ALLOW),
    },
    "i2v": {
        "label": "I2VGen-XL (image to video)",
        "repo": "ali-vilab/i2vgen-xl",
        "dir": I2V_MODEL_DIR,
        "size_gb": 5.0,
        "allow": _COMMON_ALLOW
        + [
            "feature_extractor/*",
            "image_encoder/config.json",
            "image_encoder/model.fp16.safetensors",
        ],
    },
}


# --- weights status / download ---------------------------------------------

def model_status(key: str) -> dict:
    spec = MODELS[key]
    d = spec["dir"]
    ready = os.path.isfile(os.path.join(d, COMPLETE_MARKER)) and os.path.isfile(
        os.path.join(d, "model_index.json")
    )
    return {"ready": ready, "path": d, "label": spec["label"], "size_gb": spec["size_gb"]}


def enable_hub_downloads():
    """The Rust shell forces HF_HUB_OFFLINE=1 for normal operation (the app
    must never silently hit the network mid-session). Downloads are the one
    deliberate exception, so flip it back on for the install thread."""
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "0"
    try:
        import huggingface_hub.constants as hf_constants

        hf_constants.HF_HUB_OFFLINE = False
    except Exception:
        pass


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def download_model(key: str, on_progress: Optional[Callable[[str], None]] = None) -> dict:
    status = model_status(key)
    if status["ready"]:
        return status
    spec = MODELS[key]
    enable_hub_downloads()
    from huggingface_hub import snapshot_download

    out_dir = spec["dir"]
    os.makedirs(out_dir, exist_ok=True)
    total_bytes = spec["size_gb"] * 1e9
    stop = threading.Event()

    def heartbeat():
        while not stop.wait(2.0):
            if on_progress:
                got = _dir_size(out_dir)
                on_progress(
                    "Downloading {} ({:.1f} / ~{:.1f} GB)".format(
                        spec["label"], got / 1e9, spec["size_gb"]
                    )
                )

    if on_progress:
        on_progress("Downloading {} (~{:.1f} GB)...".format(spec["label"], spec["size_gb"]))
    t = threading.Thread(target=heartbeat, daemon=True)
    t.start()
    try:
        snapshot_download(spec["repo"], local_dir=out_dir, allow_patterns=spec["allow"])
    finally:
        stop.set()
        t.join(timeout=1.0)
    if not os.path.isfile(os.path.join(out_dir, "model_index.json")):
        raise RuntimeError("Download finished but model_index.json is missing in " + out_dir)
    with open(os.path.join(out_dir, COMPLETE_MARKER), "w", encoding="utf-8") as fh:
        fh.write(spec["repo"])
    if on_progress:
        on_progress("Done.")
    return model_status(key)


# --- generation --------------------------------------------------------------

# Output sizes (width, height). ModelScope T2V was trained at 256x256: that is
# where the authentic wobbly look comes from. Wider/larger sizes still work
# (the UNet is convolutional) but drift further from the original look.
T2V_FORMATS = {
    "256x256": (256, 256),
    "384x256": (384, 256),
    "256x384": (256, 384),
    "448x256": (448, 256),
    "512x512": (512, 512),
}
# I2VGen-XL is a 1280x704 model; smaller sizes are much faster and still work.
I2V_FORMATS = {
    "1280x704": (1280, 704),
    "960x544": (960, 544),
    "704x1280": (704, 1280),
    "640x352": (640, 352),
}


# Measured on a 12 GB RTX 3060 at 1280x704 (I2VGen-XL, CPU offload, desktop running):
# 8 frames take 2.3 s/step (7.8 GB peak). 12 frames already saturate VRAM (10.2 GB
# peak, 525 s for 25 steps once the desktop takes its share) and 16 frames take
# ~120 s/step because activations spill into shared memory. The cliff is purely
# memory, so cap frames from a pixel-frame budget (8 frames at 1280x704) that
# scales with VRAM, keeping ~4 GB of headroom on a 12 GB card.
_I2V_PIXEL_FRAME_BUDGET_12GB = 7.6e6


def i2v_max_frames(width: int, height: int) -> int:
    try:
        import torch

        total_gb = torch.cuda.get_device_properties(0).total_memory / 1e9
    except Exception:
        total_gb = 12.0
    budget = _I2V_PIXEL_FRAME_BUDGET_12GB * (total_gb / 12.0)
    return max(4, int(budget // (int(width) * int(height))))


@dataclass
class GenParams:
    kind: str = "t2v"  # "t2v" | "i2v"
    prompt: str = ""
    negative_prompt: str = ""
    num_frames: int = 16
    fps: int = 8
    steps: int = 25
    guidance: float = 9.0
    seed: Optional[int] = None
    width: int = 256
    height: int = 256
    # Post-processing, applied in this order after denoising:
    #   upscale: "none" | "plain2" (bicubic x2, the old default) | "esrgan2" | "esrgan4"
    #   interp:  1 (off) | 2 | 4  (RIFE; multiplies the frame count AND the fps)
    upscale: str = "plain2"
    interp: int = 1
    init_image_path: Optional[str] = None  # i2v only
    extra: dict = field(default_factory=dict)


class AbortedError(blobtv_cancel.AbortedError):
    pass


class TelevisionEngine:
    def __init__(self):
        self._lock = threading.RLock()
        self._pipe = None
        self._kind: Optional[str] = None
        self._loading: Optional[str] = None
        self._full_gpu = False
        self.last_error: Optional[str] = None
        self._upscaler = blobtv_post.Upscaler()

    # -- status
    def status(self) -> dict:
        return {"loaded": self._kind, "loading": self._loading, "error": self.last_error}

    # -- loading
    def unload(self):
        with self._lock:
            self._pipe = None
            self._kind = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass

    def ensure_loaded(self, kind: str, on_progress: Optional[Callable[[str], None]] = None):
        with self._lock:
            if self._kind == kind and self._pipe is not None:
                return self._pipe
            if not model_status(kind)["ready"]:
                raise RuntimeError(
                    "{} weights are not installed yet. Use the Install button first.".format(
                        MODELS[kind]["label"]
                    )
                )
            self._loading = kind
            try:
                # Only one model resident at a time: the 12 GB budget is the
                # whole reason these are separate pipelines.
                if self._pipe is not None:
                    if on_progress:
                        on_progress("Unloading {}...".format(self._kind))
                    self.unload()
                if on_progress:
                    on_progress("Loading {} (importing torch/diffusers the first time can take a minute)...".format(
                        MODELS[kind]["label"]))
                t0 = time.time()
                import torch

                if not torch.cuda.is_available():
                    raise RuntimeError(
                        "No CUDA GPU detected. BlobTELEvision needs an NVIDIA GPU (see the README)."
                    )
                if kind == "t2v":
                    from diffusers import DPMSolverMultistepScheduler, TextToVideoSDPipeline

                    pipe = TextToVideoSDPipeline.from_pretrained(
                        MODELS["t2v"]["dir"], torch_dtype=torch.float16, variant="fp16"
                    )
                    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config)
                else:
                    from diffusers import I2VGenXLPipeline

                    pipe = I2VGenXLPipeline.from_pretrained(
                        MODELS["i2v"]["dir"], torch_dtype=torch.float16, variant="fp16"
                    )
                total_vram = torch.cuda.get_device_properties(0).total_memory / 1e9
                # T2V is only ~3.7 GB of weights: keeping it fully on the GPU is
                # fastest and lets us decode a live preview frame. I2VGen-XL runs
                # at much larger resolutions, so it always CPU-offloads.
                self._full_gpu = kind == "t2v" and total_vram >= 8
                if self._full_gpu:
                    pipe.to("cuda")
                else:
                    pipe.enable_model_cpu_offload()
                try:
                    pipe.enable_vae_slicing()
                except Exception:
                    pass
                self._pipe = pipe
                self._kind = kind
                self.last_error = None
                if on_progress:
                    on_progress("{} ready ({:.0f}s, {}).".format(
                        MODELS[kind]["label"], time.time() - t0,
                        "full GPU" if self._full_gpu else "CPU offload"))
                return pipe
            except Exception as exc:
                self.last_error = "{}: {}".format(type(exc).__name__, exc)
                raise
            finally:
                self._loading = None

    # -- generation
    def generate(
        self,
        p: GenParams,
        on_progress: Callable[[str], None],
        on_step: Callable[[int, int], None],
        on_phase: Callable[[str], None] = lambda _name: None,
    ) -> dict:
        import numpy as np
        import torch
        from PIL import Image

        blobtv_cancel.clear()
        with self._lock:
            pipe = self.ensure_loaded(p.kind, on_progress)
            if p.seed is None or p.seed < 0:
                p.seed = int.from_bytes(os.urandom(4), "little")
            generator = torch.Generator(device="cpu").manual_seed(int(p.seed))
            if p.kind == "i2v":
                cap = i2v_max_frames(p.width, p.height)
                if p.num_frames > cap:
                    on_progress(
                        "Capping frames {} -> {}: {}x{} would overflow your VRAM (huge slowdown). "
                        "Use Redux frame interpolation to add frames back.".format(
                            p.num_frames, cap, p.width, p.height
                        )
                    )
                    p.num_frames = cap

            total_steps = int(p.steps)
            counter = {"n": 0}
            preview_every = max(1, total_steps // 8)
            preview_path = os.path.join(outputs_dir(), "_live_preview.png")
            try:
                if os.path.isfile(preview_path):
                    os.remove(preview_path)
            except OSError:
                pass

            # Both pipelines call scheduler.step() exactly once per denoising
            # step, so wrapping it gives uniform progress + cooperative cancel
            # (I2VGen-XL has no per-step callback at all).
            scheduler = pipe.scheduler
            orig_step = scheduler.step

            def step_wrapper(model_output, timestep, sample, *a, **kw):
                if blobtv_cancel.is_requested():
                    raise AbortedError("Aborted")
                result = orig_step(model_output, timestep, sample, *a, **kw)
                counter["n"] += 1
                on_step(counter["n"], total_steps)
                if self._full_gpu and p.kind == "t2v" and counter["n"] % preview_every == 0:
                    self._write_preview(pipe, sample, preview_path)
                return result

            scheduler.step = step_wrapper
            try:
                on_phase("Denoising")
                on_progress("Generating {} frames, {} steps, seed {}...".format(p.num_frames, total_steps, p.seed))
                t0 = time.time()
                if p.kind == "t2v":
                    out = pipe(
                        prompt=p.prompt,
                        negative_prompt=p.negative_prompt or None,
                        num_frames=int(p.num_frames),
                        num_inference_steps=total_steps,
                        guidance_scale=float(p.guidance),
                        width=int(p.width),
                        height=int(p.height),
                        generator=generator,
                        output_type="np",
                    )
                else:
                    if not p.init_image_path or not os.path.isfile(p.init_image_path):
                        raise RuntimeError("Image-to-video needs a source image.")
                    image = Image.open(p.init_image_path).convert("RGB")
                    out = pipe(
                        prompt=p.prompt,
                        image=image,
                        negative_prompt=p.negative_prompt or None,
                        num_frames=int(p.num_frames),
                        num_inference_steps=total_steps,
                        guidance_scale=float(p.guidance),
                        width=int(p.width),
                        height=int(p.height),
                        target_fps=int(p.fps),
                        decode_chunk_size=2,
                        generator=generator,
                        output_type="np",
                    )
                on_progress("Denoising done ({:.0f}s).".format(time.time() - t0))
            finally:
                scheduler.step = orig_step
                try:
                    if os.path.isfile(preview_path):
                        os.remove(preview_path)
                except OSError:
                    pass

            frames = out.frames[0]
            frames = np.asarray(frames)
            if frames.dtype != np.uint8:
                frames = (np.clip(frames, 0.0, 1.0) * 255.0).round().astype(np.uint8)
            frames = self._postprocess(frames, p, on_progress, on_step, on_phase)
            on_phase("Encoding")
            on_progress("Encoding video...")
            return self._save_video(frames, p)

    def _postprocess(self, frames, p: GenParams, on_progress, on_step, on_phase):
        """Optional Redux steps. Order matters: upscale first, then interpolate
        (same order TRACE-V uses), so RIFE works on the upscaled frames."""
        import numpy as np
        from PIL import Image

        if p.upscale == "plain2":
            frames = np.stack(
                [
                    np.asarray(Image.fromarray(f).resize((f.shape[1] * 2, f.shape[0] * 2), Image.BICUBIC))
                    for f in frames
                ]
            )
        elif p.upscale in ("esrgan2", "esrgan4"):
            scale = 2 if p.upscale == "esrgan2" else 4
            on_phase("Upscaling")
            t0 = time.time()
            on_progress("Real-ESRGAN x{}: {}x{} -> {}x{}...".format(
                scale, frames.shape[2], frames.shape[1], frames.shape[2] * scale, frames.shape[1] * scale))
            frames = self._upscaler.upscale_frames(frames, scale, on_step)
            on_progress("Upscaled in {:.0f}s.".format(time.time() - t0))
        if p.interp and p.interp > 1:
            on_phase("Interpolating")
            t0 = time.time()
            on_progress("RIFE x{}: {} frames in...".format(p.interp, len(frames)))
            frames = blobtv_post.interpolate_rife(frames, int(p.interp), on_progress, on_step)
            on_progress("Interpolated in {:.0f}s.".format(time.time() - t0))
        return frames

    def _write_preview(self, pipe, sample, path):
        """Decode the middle frame of the current latents into a PNG the UI
        polls. `sample` is (frames, 4, h, w): the T2V pipeline already folds
        frames into the batch dimension before calling scheduler.step().
        Strictly best-effort: a preview failure must never fail the render."""
        try:
            import torch
            from PIL import Image

            k = sample.shape[0] // 2
            lat = sample[k : k + 1].to(pipe.vae.dtype) / pipe.vae.config.scaling_factor
            with torch.no_grad():
                img = pipe.vae.decode(lat).sample
            img = (img / 2 + 0.5).clamp(0, 1)[0].permute(1, 2, 0).float().cpu().numpy()
            tmp = path + ".tmp.png"
            Image.fromarray((img * 255).round().astype("uint8")).save(tmp)
            os.replace(tmp, path)
        except Exception:
            pass

    def _save_video(self, frames, p: GenParams) -> dict:
        import imageio.v2 as imageio

        name = build_output_name("T" if p.kind == "t2v" else "I", p.prompt or "video", ".mp4")
        path = os.path.join(outputs_dir(), name)
        imageio.mimwrite(
            path,
            list(frames),
            fps=int(p.fps) * max(1, int(p.interp or 1)),
            codec="libx264",
            quality=8,
            pixelformat="yuv420p",
            macro_block_size=2,
        )
        meta = {
            "app": "blobtelevision",
            "kind": p.kind,
            "prompt": p.prompt,
            "negative_prompt": p.negative_prompt,
            "seed": p.seed,
            "steps": p.steps,
            "guidance": p.guidance,
            "num_frames": p.num_frames,
            "fps": p.fps * max(1, int(p.interp or 1)),
            "base_fps": p.fps,
            "upscale": p.upscale,
            "interp": p.interp,
            "output_size": [int(frames.shape[2]), int(frames.shape[1])],
            "width": p.width,
            "height": p.height,
            "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
        return {"filename": name, "path": path, "metadata": meta}
