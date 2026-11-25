# H3 Studio: usage

H3 Studio is a local web frontend for MiniMax H3 running in ComfyUI. One aiohttp server serves the UI and proxies ComfyUI, so everything happens on `127.0.0.1` and no data leaves your machine.

## Quick start

```sh
./run.sh          # then open http://127.0.0.1:8190
```

`run.sh` execs ComfyUI's venv Python (`~/comfyui/repo/venv/bin/python` unless `COMFY_PY` is set), which is already assumed to have `aiohttp`. Nothing else needs installing.

Header buttons:

- **Start ComfyUI**: only shown when ComfyUI is unreachable. Runs `~/comfyui/launch.sh` (or, if that file does not exist, `repo/venv/bin/python main.py --disable-pinned-memory --fp16-intermediates --fast-disk --port <port>`) with output appended to `<comfy-dir>/comfyui.log`.
- **Stop ComfyUI**: confirms first; then SIGTERMs every process listening on the ComfyUI port (never H3 Studio itself).
- **Free VRAM**: unloads models (`/free`).
- **Theme**: cycles system → light → dark; persisted.

## Tabs

| Tab | Use for |
|---|---|
| Text → Image | New images from a prompt. |
| Image → Image | One-source editing: upload exactly one Picture 1. `<Picture 1>` is auto-prepended to the prompt. |
| Multi-image → Image | Up to 9 Pictures (Picture 1 is the source); extra references are referenced as `<Picture 2>`…. The builder supports one card per Picture. |
| Video | Text → video, first/first+last frame, or reference-guided video (see below). |

Each mode has separate persisted form state (`localStorage`, prefix `h3studio.`).

## Prompt builder

Pinned next to the prompt field on Text → Image and the edit tabs. It assembles an official-style prompt from numbered steps instead of free typing.

**Text → Image**

1. Image type (photo, cinematic, illustration, painting, poster, infographic, UI screen, product shot, logo, grid/storyboard, free): sets the opening line, shown as a live preview.
2. Subject: one frozen moment: what the image shows.
3. Layout: where things sit (left/right, foreground, grid rows × columns).
4. Text on the image: every visible word in quotes, with its placement; the **No text in the image** toggle skips this step.
5. Look: light, materials, colour (visible attributes only).
6. Exclusions & canvas: optional; an exclusions line and a canvas ratio, with the option to sync the canvas ratio back to the Canvas section when the prompt is replaced.

**Image → Image / Multi-image**

1. References: one card per uploaded Picture: what the picture contributes, and how it is used (`fully preserved` / `partially preserved` / `exact property transfer` / `weak reference`), plus a Detail line. Quick chips cover identity-locked edits (e.g. change clothes/pose/expression, keep the face).
2. Target: the finished image in one line ("The target image …" is prepended).
3. Changes & new content: the final state, not commands; note the changes that matter (a colour change, a new background…).
4. Text on the image: optional.

The right-hand panel shows the assembled paragraph live, an approximate token budget (4096 cap), a per-step checklist, a chip row that inserts `<Picture N>` / `<Subject N>` / `<Video N>` / `<Audio N>` at the cursor, and the actions **Replace prompt**, **Add to prompt**, **Copy**, **Clear**, **Load example…**, Guide (opens the vendored official guide). Runs produced from the builder are logged with `prompt_source: "builder"`; typing raw into the prompt box logs `prompt_source: "raw"`.

Builder examples are official-style briefs (potter photograph, sales dashboard for Text → Image; blue-cup local colour edit, fashion-poster property transfer, identity-locked café portrait for editing). Nothing in the app writes anything outside the brief.

## Canvas

Image modes: aspect ratio (or `source image`, which follows Picture 1's geometry) + megapixels → width/height computed as `sqrt(area·ratio)`, rounded to 32 px. Aspect ratios come live from ComfyUI's node info. Custom width/height inputs are also available.

Video modes: aspect (or `match first frame`, or `custom pixels`) with an area cap (768×1344) and a size preset (0.2 / 0.4 / 0.6 / 0.8 / native MP), then rounded to 32 px. Width/height inputs are also available.

## Video

Variables:

- **Video mode**: Text → Video / First frame / First + last frame / References → Video.
- **Reference images**: up to 9, `<Picture N>`; draggable to reorder. **Reference videos**: up to 3, `<Video N>`, 2–15 s each. **Reference audio**: up to 3, `<Audio N>`. Toggle **Use each reference video's soundtrack** to also pass each video's audio as `<Audio N>` input.
- **Reference image size**: `match` (generation area, faster) or `max` (2048 px, best identity, slower).
- **Duration**: 0.5–15 s slider; output frame count is `max(5, round(sec × 24))` advanced to `n % 17 === 5` (H3 samples on a 17k+5 frame grid; the trained range is ≈ 5–15 s / 124–362 frames).
- **Frame rate (output)**: default 24 fps.
- **Output**: container (auto/mp4/mkv/webm), codec (auto/h264/av1), optional H.264 CRF (blank = auto), bit depth (auto/8/10), colour space (sRGB/HDR/HDR PQ), and a **Include generated audio track** toggle.
- **Sigma shift**: optional override for video and audio (off by default; the node chain applies its own shift when unchecked).

Keyframe guides pin an image or audio anchor at a frame index (negative = count from the end). They are wired in as `MiniMaxH3AddGuide` nodes between the reference chain and the sampler. An outside-clip warning appears when a guide exceeds the frame count.

## Sampling & models

- **Steps / Sampler / Scheduler**: read live from ComfyUI `/object_info`. Sampling presets render per mode: Text → Image shows official-checkpoint (6 steps, CFG 1, auto-selected for `h3_image` checkpoints) / Quality / Turbo / Preview / Final; Video shows Template / Turbo LoRA / Draft / Final. LoRA strength 0 or None is skipped.
- **Seed**: number + dice randomizer; **After each run**: keep / increment / randomize (index 0 keeps the base seed); **Batch count**: 1–64 runs, with per-index seeds.
- **Models & LoRAs**: diffusion model, text encoder, (image) VAE or (video) video VAE + audio VAE, weight dtype (video), and a multi-row LoRA stack. The turbo LoRA is detected from its filename.
- **Output**: filename prefix (with a video default `video/h3studio`) plus the video output options above.

## Results gallery

Every queued run appears immediately and updates live over the websocket (`executing` → per-node progress, `executed` → outputs, `execution_success` / `execution_error` → finished). Result cards show mode, seed, status, a one-line summary, the prompt, outputs (with a live-preview overlay while generating) and any error. Filter chips (All / Images / Videos / Failed) with counts, a search box (seed, prompt, run id), and bulk actions: download, send-to-Edit (single image → Image → Image; multi-image → Multi-image), remove, clear. Clicking a card opens a lightbox (arrows to navigate, Escape to close).

Drag any result image into a drop zone, or paste with Ctrl+V, to use it as an input. On a card: **Send to Edit**, **↺ Settings** (restores mode + every form setting + lists + guides), copy seed.

**API JSON** shows or downloads the exact graph for the current seed. Repeat a run from a script with it.

## Logging

Every finished or failed run is appended to the log with its prompt, inputs, outputs, settings and the full API graph (see `docs/runs-log.md`). The log is server-side JSONL and is **git-ignored**: it contains prompts and outputs, so do not commit it. `--log` points it at a project directory. Note the record is written even when the UI is closed or the tab crashes; the server adds the `logged` timestamp.

## Keyboard & shortcuts

- **Ctrl/Cmd+Enter**: generate (or, while typing in the prompt builder, apply the assembled draft).
- **Escape**: close the lightbox / modal / confirm dialog.
- Arrow keys: lightbox navigation.
- Arrows / Home / End: tab navigation.

## Persistence

Form state, lists, guides, theme, collapsible bands and the last 200 runs are kept in `localStorage` (prefix `h3studio.`; quota-tolerant). Graphs are stripped from the persisted runs (they live in the log).
