# H3 Studio: architecture

One process, two halves: an aiohttp server that serves the UI and proxies ComfyUI, and a single-page client that builds ComfyUI API graphs and renders results. There is no build step. Everything is plain HTML/JS/CSS served by the server.

```
┌─────────────────┐        ┌─────────────────────────────┐        ┌──────────────┐
│  Browser        │  GET   │  server.py (aiohttp)        │  HTTP  │              │
│  static/        │◄───────►│  :8190                     │◄──────►│  ComfyUI     │
│  app.js         │  proxy │  (/comfy/*, /comfy/ws)      │        │  :8188       │
│                 │        │  static/, docs/            │        │              │
│                 │  POST  │  /api/log, /api/start-comfy │        └──────────────┘
│                 │───────►│        /api/stop-comfy
└─────────────────┘        └─────────────────────────────┘
        │                              │
        │  localStorage (h3studio.*)   │  runs.jsonl (AI-use log)
        ▼                              ▼
```

## Server (`server.py`)

Thin reverse proxy + small API. Binds `127.0.0.1` only.

| Route | Handler | Notes |
|---|---|---|
| `GET /` | `index.html` | the single page |
| `/static/*` | static files | cached by the browser-safe default; `docs/` is served from the same checkout |
| `/docs/*` | static files | the vendored prompt guides (and any other docs) shown by the builder's Guide button |
| `GET /comfy/ws` | websocket proxy | forwards `/ws?clientId=…` with the query string preserved; binary frames (type 1 PNG, type 2 JPEG) stream straight through and drive the live preview |
| `* /comfy/{tail}` | HTTP proxy | any method and body, streamed in chunks; drops browser-only headers (Host, Origin, Referer, Content-Length, Accept-Encoding…); preserves only Content-Type/Disposition/Cache-Control on the way back; 502 when ComfyUI is down; 499 when the browser goes away mid-stream |
| `POST /api/log` | `log_run` | appends one JSON line (adds a local timestamp) to `--log`; creates parent directories |
| `POST /api/start-comfy` | `start_comfy` | spawns `launch.sh` in `--comfy-dir` (falls back to `repo/venv/bin/python main.py --disable-pinned-memory --fp16-intermediates --fast-disk --port <port>`) with output appended to `<comfy-dir>/comfyui.log` |
| `POST /api/stop-comfy` | `stop_comfy` | `lsof -ti tcp:<port>` → SIGTERM each PID (never the server's own or its parent's); 404 when nothing listens; 403 when a PID is not ours to kill |

`client_max_size` is 4 GB so large images pass through. `run.sh` execs ComfyUI's venv Python (default `~/comfyui/repo/venv/bin/python`, override with `COMFY_PY`). There is no separate dependency list.

## Client (`static/app.js`)

The whole UI in one file. Key pieces:

- **State**: a single `S` object: `mode`, `lists` (uploaded assets per slot group), `guides` (video keyframe anchors), `loras`, `bld` (prompt-builder drafts), `runs` (the gallery; the last 200 persisted, graphs stripped), `bands`, `theme`, `promptSource`. All persisted under `localStorage` keys prefixed `h3studio.`.
- **Graph builders**: `buildImage()` and `buildVideo()` return a flat `{node: {class_type, inputs}}` API graph. Two image paths:
  - **Official standalone checkpoint** (model filename matches `/h3_image/i`): `UNETLoader` → `LoraLoaderModelOnly` chain → `CLIPLoader` (type `minimax`) → `VAELoader` → `MiniMaxH3ImageConditioning` (width/height + `images.image_N`) → `ConditioningZeroOut` → `KSampler` (CFG 1, any sampler, usually 6 steps) → `VAEDecodeTiled` (1024 tile / 64 temporal / 64 overlap) → `SaveImage`.
  - **H3 Studio custom nodes**: `H3StudioModels` (+ one `H3StudioLoRA` per LoRA, strengths 0/None skipped) → `H3StudioGenerate` (text → image) or `H3StudioEdit` (image → image; multi-reference passes `references.reference_image_N`) → `H3StudioRender` → `SaveImage` + `PreviewAny`.
  - **Video** is always the native node chain: `UNETLoader`/`UnetLoaderGGUF` → LoRA chain → optional `MiniMaxH3SigmaShift` → `CLIPLoader` → `VAELoader` (video + `VAEDecodeAudio`) → `MiniMaxH3ImageToVideo` (text / first / first+last) or `MiniMaxH3ReferenceToVideo` (images, videos with optional soundtrack, audio) → `MiniMaxH3AddGuide` chain per guide → `SamplerCustomAdvanced` (`RandomNoise` → `BasicGuider` → `KSamplerSelect` → `BasicScheduler`) → `VAEDecode` (+ `VAEDecodeAudio`) → `CreateVideo` → `SaveVideo`.
- **Validation**: runs through `check()` before queuing; prompt/model/mode-specific errors are surfaced and, for prompt-level failures, filtered from the API-error view (`formatNodeErrors`).
- **Queue & lifecycle**: `post('prompt', {prompt, client_id})` to ComfyUI; each batch index gets its own seed and graph. The websocket (`/comfy/ws?clientId=`) drives `status`, `execution_start`, `executing` (node name → progress), `progress`, `executed` (outputs merged into the run), `execution_success` / `execution_error` / `execution_interrupted`. A 3 s backstop polls `/history/{prompt_id}` when the socket is down, and binary WS frames render a floating live preview.
- **Results & logging**: `finish()` toasts, fires `POST /api/log` with the record (see `docs/runs-log.md`) and re-renders the gallery. Result cards keep everything needed for ↺ Settings restore, send-to-Edit, bulk download and the lightbox.
- **Builder**: `BLD_*` constants (types, ratios, relationships, examples) plus `bldOut()` to assemble the prompt. The assembled draft is previewed live and can be replaced/appended to the prompt field, or logged with `prompt_source: "builder"`.

## Run lifecycle

```
build(seed) ──► POST /comfy/prompt ──► run {id, graph, restore}
                                        │
                 websocket ◄────────────┤  (status/executing/progress/executed/success|error|interrupted)
                                        │
                                 finish(run, status, error)
                                        │
                          POST /api/log  ──► runs.jsonl line (prompt, inputs, outputs, settings, full graph)
```

## File layout

| Path | Contents |
|---|---|
| `server.py` | aiohttp app: static serving, ComfyUI proxy, start/stop ComfyUI, run logging |
| `run.sh` | execs ComfyUI's venv Python with `server.py` |
| `static/index.html` | the single page: header (tabs, status, buttons), form, results panel, modal, toasts |
| `static/app.js` | all client logic: state, graph builders, prompt builder, video/guides, results, persistence |
| `static/style.css` | the two-palette (light / system-dark / dark) design |
| `docs/` | this file, `usage.md`, `runs-log.md`, and the vendored official prompt guides (`prompt-guide-t2i.md`, `prompt-guide-edit.md`; MIT © MiniMax) |
| `runs.jsonl` | the append-only AI-use record (git-ignored) |

## Notes & limits

- `runs.jsonl` is written server-side; the UI call is fire-and-forget (a failed log POST is swallowed). The log is the durable record.
- The persisted gallery keeps the last 200 runs, with graphs stripped; the full graph lives only in the logged record.
- The video path has no logged runs in the default log yet; the image paths have.
- There is no LICENSE file. Vendored guides are MIT © MiniMax; the rest of the repo is unlicensed.
