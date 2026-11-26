# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BlobTELEvision is the video sibling of BlobVision (same author, forked from it): a portable Windows
desktop app (Tauri shell + Python FastAPI engine) that emulates the first, hilariously cursed
generative-AI video models. It does one thing, in two modes:

- **text to video**: ModelScope text-to-video (`damo-vilab/text-to-video-ms-1.7b`, 2023, trained at 256 px).
- **image to video**: I2VGen-XL (`ali-vilab/i2vgen-xl`), optional second download.

Both run through `diffusers` (`TextToVideoSDPipeline`, `I2VGenXLPipeline`) from fp16 safetensors, one
model resident on the GPU at a time. There are no image models, no VQGAN/CLIP/DeepDream/Style Transfer
and no SDXL: those live in BlobVision and were deliberately stripped from this fork.

## Running

No test suite, linter or CI. Dev setup mirrors BlobVision:

```
BlobTELEvision-Dev.bat                 # npm run tauri dev (recompiles Rust each launch)
BlobTELEvision.bat                     # runs tauri/src-tauri/target/release/blobtelevision.exe
cd tauri && npm run tauri build        # release exe + NSIS installer (target/release/bundle/nsis/)
venv\Scripts\python.exe app\python\blobtv_api.py --port 8421    # backend alone (Swagger at /docs)
cd tauri && npx vite --host 127.0.0.1   # frontend alone in a browser, against a running backend
```

Type-check the frontend with `npx tsc --noEmit` from `tauri/`.

## Architecture

- `tauri/src-tauri/src/main.rs`: spawns `pythonw.exe app/python/blobtv_api.py --port 8421` (python.exe in
  dev), bootstraps a relocatable venv on a fresh machine (`app/scripts/bootstrap_venv.ps1`, reads
  `app/requirements-frozen.txt`), implements "Fast reboot" (leave the engine alive after the window closes;
  the API exits by itself after 30 idle minutes) and reuses an already-running engine on port 8421.
  `app/` is bundled as a Tauri resource, so **Python changes need a rebuild to reach the shipped exe**.
  `repo_root()` takes the OUTERMOST folder containing `app/python/blobtv_api.py` (the nearest one would be
  `target/debug|release`, which holds a copy of the bundled `app/`, and the venv/models would land there).
  Every child process (bootstrap, engine and its own children) is put in one Windows job object
  (`mod job`); with Fast reboot off it has KILL_ON_JOB_CLOSE, so closing or crashing the app kills the whole
  tree. An engine reused from an earlier Fast reboot session is stopped with `POST /shutdown`.
  A flat-layout venv only counts as installed once `venv/.bootstrap_complete` exists (written last by
  `bootstrap_venv.ps1`), so an interrupted install is wiped and redone instead of trusted.
- Startup speed: the engine preloads text-to-video by itself right after starting (`--no-warmup` disables it)
  and reads the fp16 weight files in threads while Python imports torch/diffusers (~16 s of CPU-bound
  imports; threads do not speed those up). The bootstrap installs PyTorch and all other packages in one
  `uv pip install` (PyTorch wheels through `--find-links`) so the small packages download while the
  ~2.7 GB torch wheel is still coming in, and it does not install pip.
- `app/python/blobtv_api.py`: FastAPI. Jobs are polled (`POST /generate` -> `GET /jobs/{id}`), model install
  is fire-and-forget (`POST /models/install`, poll `/models/status`), `/cancel` sets a cooperative flag.
- `app/python/blobtv_engine.py`: model registry (`MODELS`), weights status/download, the engine. Importing it
  must stay cheap (no torch/diffusers at module level) so `/health` and `/models/status` answer before any
  weights exist. Progress and cancel work by wrapping `scheduler.step`, because I2VGen-XL has no per-step callback.
  T2V stays fully on the GPU (live preview frame decoded from the current latents into
  `outputs/_live_preview.png`); I2V always uses CPU offload.
- `app/python/blobtv_post.py`: the optional **Redux** post-processing, applied after denoising in this order:
  upscale (plain bicubic x2, or Real-ESRGAN x2/x4 through `spandrel`, tiled) then RIFE interpolation
  (`rife-ncnn-vulkan.exe` as a cancellable subprocess, model `rife-v4.6`, which can hit an arbitrary
  frame count with `-n`). Everything is opt-in per generation; the tools are installed on demand into
  `models/upscale/` and `models/rife/` (the RIFE zip is ~430 MB, only v4.6 is kept). Inspired by TRACE-V
  in the PNAKOTUS-V2 repo (same Real-ESRGAN + RIFE tools), without its compression logic.
- `app/python/blobtv_paths.py`: all path layout. Always resolve paths through it (portable app, no cwd assumptions).
- `tauri/src/main.ts` + `index.html` + `style.css`: single-panel frontend, no framework.
  Image -> videslop sources: file picker, drop anywhere on the window (the webview must keep `dragDropEnabled: false`),
  or a frame captured from the video on the TV (the `<video>` has `crossorigin` and the API sends CORS headers, otherwise the canvas is tainted).
  The page must not scroll: the screen width in `#output-box` and `.side-col` max-height both reserve the other elements' height in rem.

## Conventions and gotchas

- Weights live in `models/modelscope-t2v` and `models/i2vgen-xl`, installed via the in-app button. A
  `.blobtv_complete` marker file (written after a finished `snapshot_download`) is what counts as "installed".
- The Rust shell forces `HF_HUB_OFFLINE=1`; only `enable_hub_downloads()` flips it back for downloads.
- The port (8421) must match between `main.rs` and `main.ts`; BlobVision uses 8420, so both apps coexist.
- Piped build commands mask exit codes: run builds as `cmd > log 2>&1; echo $?`.
- `ensure_layout()` sweeps `work/` once per process only (a re-sweep mid-session deletes active job files).
- Redux interpolation multiplies the fps by the same factor as the frame count, so the duration is preserved
  (N frames -> N*f-(f-1)). The JSON sidecar records `base_fps`, `upscale`, `interp` and `output_size`.
- I2VGen-XL has a VRAM cliff, not a gradual slowdown (`i2v_max_frames` in `blobtv_engine.py`): at 1280x704 on a
  12 GB card, 8 frames run at 2.3 s/step, 12 frames saturate VRAM (~9 min per job) and 16 frames take ~120 s/step.
  Frames are therefore capped automatically from a pixel-frame budget that scales with VRAM; the UI shows a
  "NEEDS STRONG GPU" pill with an explanatory bubble for those formats. `unet.enable_forward_chunking()` was
  tried and is much slower (68 s/step), don't re-try it.
- Output files: `YYMMDD_T_NNN_prompt.mp4` (text to video) / `_I_` (image to video) plus a `.json` sidecar with the parameters.
