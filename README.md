<p align="center">
  <a href="https://github.com/PyaesoneP/SUTDio"><img src="assets/sutdio-logo.svg" width="260" alt="SUTDio logo" /></a>
</p>

# SUTDio

<p align="center">
  <em>Free, local image generation for SUTD students</em>
</p>

<p align="center">
  <sub>Built by a SUTD student</sub>
</p>

<p align="center">
  <a href="https://github.com/PyaesoneP/SUTDio/blob/main/CHANGELOG.md"><img src="https://img.shields.io/badge/status-v0.2.0--beta.1--draft-orange" alt="Status: v0.2.0-beta.1 draft" /></a>
  <img src="https://img.shields.io/badge/python-3.12%2B-blue" alt="Python 3.12+" />
  <img src="https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS-lightgrey" alt="Platform: Linux / macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-lightgrey" alt="License: Apache 2.0" /></a>
  <a href="https://github.com/PyaesoneP/SUTDio/stargazers"><img src="https://img.shields.io/github/stars/PyaesoneP/SUTDio?style=flat-square" alt="Stars" /></a>
</p>

SUTDio is a local web frontend for [MiniMax H3](https://github.com/MiniMax-AI/MiniMax-H3-Image) in ComfyUI. It covers text to image, image to image, multi-reference edits and video in one instrument-panel-style UI with a results gallery.

## System requirements

- **A working ComfyUI install** with MiniMax H3 support: the H3 Studio custom nodes (`H3StudioModels` / `H3StudioGenerate` / `H3StudioEdit` / `H3StudioRender`) **or** the official standalone-checkpoint path (`h3_image` diffusion checkpoint + `CLIPLoader` with type `minimax` + image VAE). Default location: `~/comfyui` (override with `--comfy-dir`).
- **A MiniMax H3 diffusion model** for the selected tab (plus its text encoder and VAE); video also needs the video VAE and an audio VAE. Model/LoRA choices are read live from ComfyUI, so anything ComfyUI already loads will appear.
- **POSIX environment**: Linux or macOS with a bash shell and `lsof` (used by the Stop ComfyUI button; everything else works without it). Windows is not supported.
- **Python 3.12+** with `aiohttp`. In practice ComfyUI's own venv (`~/comfyui/repo/venv/bin/python`), which `run.sh` execs by default. Any interpreter with `aiohttp` works via `COMFY_PY`.
- **A modern browser** with WebSocket support (any current Chrome/Firefox/Safari), on the same host as ComfyUI.
- **RAM/VRAM** sufficient for the model you load, plus disk space for outputs under ComfyUI's output directory.

Nothing else to install: the UI, prompt builder and proxy are served by the one `server.py` process, and `run.sh` needs no extra dependencies.

## Quick start

```sh
./run.sh          # then open http://127.0.0.1:8190
```

`run.sh` execs ComfyUI's own venv Python (which already has `aiohttp`), so nothing needs installing. If ComfyUI is not running, the header shows a **Start ComfyUI** button (runs `~/comfyui/launch.sh`, or launches `repo/venv/bin/python main.py …` when no `launch.sh` exists). **Stop ComfyUI** (with a confirm dialog) terminates the ComfyUI process listening on the configured port; **Free VRAM** unloads models.

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `8190` | Port SUTDio is served on |
| `--comfy` | `http://127.0.0.1:8188` | ComfyUI URL SUTDio proxies |
| `--comfy-dir` | `~/comfyui` | Folder with `launch.sh` (used by the Start/Stop buttons) |
| `--log` | `./runs.jsonl` | Where run records are appended |

`COMFY_PY` overrides the Python used by `run.sh`. Example: `./run.sh --log ~/iDea/working/h3_studio/runs.jsonl`.

## Modes

| Tab | ComfyUI graph |
|---|---|
| Text → Image | H3 Models → H3 LoRA chain → H3 Text to Image → H3 Render Image → Save / Preview (or the official standalone-checkpoint path: `UNETLoader`/`CLIPLoader`/`VAELoader` → `MiniMaxH3ImageConditioning` → `KSampler` → tiled `VAEDecodeTiled`) |
| Image → Image | same, with H3 Image Edit and `<Picture 1>` |
| Multi-image → Image | H3 Image Edit with up to 8 extra references (`references.reference_image_N`) |
| Video | `UNETLoader`/GGUF → LoRAs → optional sigma shift → `MiniMaxH3ImageToVideo` (text / first / first+last) or `MiniMaxH3ReferenceToVideo` (images, videos with their soundtrack, audio) → keyframe guides (`MiniMaxH3AddGuide`) → `SamplerCustomAdvanced` → video + audio `VAEDecode` → `CreateVideo` → `SaveVideo` |

The image modes follow the official MiniMax H3-Image checkpoint (`h3_image` in the model filename) with a dedicated core-node graph path (tiled VAE decode); other checkpoints use the H3 Studio custom nodes (`H3StudioModels` / `H3StudioGenerate` / `H3StudioEdit` / `H3StudioRender`). Option lists (models, LoRAs, samplers, schedulers, aspect ratios) are read live from ComfyUI `/object_info`.

## Features

- **Prompt builder** (Text → Image and the edit tabs): numbered steps with a live assembled preview pinned beside them, following the official H3-Image writing guides. Text → Image: image type (sets the opening line) → subject → layout → quoted lettering with placement (+ no-text toggle) → light/material/colour → optional exclusions and canvas ratio (optionally synced to Canvas). Editing: one card per uploaded Picture (thumbnail + `⟨Picture N⟩ → ⟨Subject N⟩` relationship: fully / partially preserved, exact property transfer, weak reference), with quick chips for identity-locked edits (change clothes/pose/expression, keep the face) → target overview → changed details. Official-style examples in **Load example…**; runs logged from the builder carry `prompt_source: "builder"` in `runs.jsonl`.
- **Keyframe guides** (video): image or audio anchors at any frame (negative indices count from the end), wired into the conditioning chain.
- **Results gallery**: filter chips (All / Images / Videos / Failed) with counts, search (seed, prompt, run id), multi-select with bulk download / send-to-Edit / remove, lightbox, drag any result into any drop zone, paste images with Ctrl+V, and **↺ Settings** to restore a run's full settings.
- **Run logging**: every finished or failed run is appended to `runs.jsonl` with its prompt, inputs, outputs, settings and full API graph, an AI-use record. Point it at a project with `--log`.
- **API JSON**: shows or downloads the exact graph for the current seed, so a run can be repeated from a script.
- **Theme** (system / light / dark), per-mode form persistence (`localStorage`), keyboard shortcuts (Ctrl/Cmd+Enter to generate, Escape to close, arrows in the lightbox).

## Documentation

- [`docs/usage.md`](docs/usage.md): full walkthrough: tabs, prompt builder, video modes, keyframe guides, gallery, persistence, keyboard
- [`docs/architecture.md`](docs/architecture.md): how it works: aiohttp proxy, client-side graph builders, run lifecycle, files
- [`docs/runs-log.md`](docs/runs-log.md): the `runs.jsonl` AI-use record schema
- [`docs/prompt-guide-t2i.md`](docs/prompt-guide-t2i.md) · [`docs/prompt-guide-edit.md`](docs/prompt-guide-edit.md): vendored official MiniMax H3-Image prompt-writing guides (MIT © MiniMax), also readable via the builder's Guide button

## Status & notes

Pre-release (v0.2.0-beta.1, draft). The video path has not been exercised by any logged run yet. `runs.jsonl` is git-ignored on purpose: it contains prompts, inputs and outputs. SUTDio is open-source under the [Apache License 2.0](LICENSE), except the vendored official guides (`docs/prompt-guide-t2i.md` and `docs/prompt-guide-edit.md`), which remain MIT © MiniMax.
