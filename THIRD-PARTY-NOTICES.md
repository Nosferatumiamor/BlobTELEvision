# Third-party notices

BlobTELEvision's own code is MIT licensed (see `LICENSE`). It does **not** redistribute any model weights.
Everything below is downloaded by the app, on request, from its authors' own repositories, and keeps its own
license. Read them before using results commercially.

## Models (downloaded on demand)

| Model | Made by | License |
| --- | --- | --- |
| [ModelScope text-to-video 1.7B](https://huggingface.co/damo-vilab/text-to-video-ms-1.7b) | DAMO Vision Intelligence Lab, Alibaba | CC BY-NC 4.0, **non-commercial use only** |
| [I2VGen-XL](https://huggingface.co/ali-vilab/i2vgen-xl) | Alibaba (ali-vilab) | MIT |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) x2plus / x4plus (Redux, optional) | Xintao Wang et al. | BSD-3-Clause |
| [RIFE ncnn Vulkan](https://github.com/nihui/rife-ncnn-vulkan) (Redux, optional) | RIFE: Zhewei Huang et al., ncnn build: nihui | MIT |

The ModelScope license matters most: the weights are for non-commercial use, and that applies to what you do
with the videos they generate. The demo clip in this repository was made with that model and is shown for
illustration only.

## Tools and libraries (installed on first launch, or part of the app shell)

| Project | By | License |
| --- | --- | --- |
| [PyTorch](https://pytorch.org) | PyTorch Foundation | BSD-3-Clause |
| [diffusers](https://github.com/huggingface/diffusers), [transformers](https://github.com/huggingface/transformers), huggingface_hub, accelerate, safetensors | Hugging Face | Apache-2.0 |
| [spandrel](https://github.com/chaiNNer-org/spandrel) | chaiNNer team | MIT |
| [FastAPI](https://github.com/fastapi/fastapi) | Sebastián Ramírez | MIT |
| [uvicorn](https://github.com/encode/uvicorn) | Encode | BSD-3-Clause |
| [ImageIO](https://github.com/imageio/imageio) + imageio-ffmpeg | ImageIO contributors | BSD-2-Clause (the bundled FFmpeg build keeps its own LGPL/GPL terms) |
| Pillow, NumPy | their contributors | HPND, BSD-3-Clause |
| [Tauri](https://tauri.app) | Tauri Programme | MIT or Apache-2.0 |
| [uv](https://github.com/astral-sh/uv) (installs the Python environment) | Astral | MIT or Apache-2.0 |
| [Python](https://www.python.org) (embeddable distribution) | Python Software Foundation | PSF License |

The exact Python package versions are pinned in `app/requirements-frozen.txt`.
