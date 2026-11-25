# Changelog

All notable changes to H3 Studio are recorded here. This project is pre-release: tags move fast and the UI is not yet stable.

## [v0.2.0-beta.1] — draft

Status: **draft pre-release** — not published. Covers the uncommitted working tree on `main`; the tag should point at a commit containing this work (see below).

### Added

- **Prompt builder** (Text → Image and the edit tabs): numbered steps following the official MiniMax H3-Image writing guides — Text → Image: image type (sets the opening line) → subject → layout → quoted lettering with placement (+ no-text toggle) → light/material/colour → optional exclusions and canvas ratio (with canvas-sync). Editing: one card per Picture (thumbnail + `⟨Picture N⟩ → ⟨Subject N⟩` relationship — fully/partially preserved, exact property transfer, weak reference — with detail and identity-lock quick chips) → target overview → changed details → optional text. Live assembled preview with a token-budget bar, per-step checklist, reference-tag chip row, official-style examples (Load example…), 📖 Guide viewer, and Replace/Add-to/Copy/Clear actions. Builder runs log `prompt_source: "builder"`.
- **Keyframe guides** for video: image or audio anchors at a frame index (negative = from the end), wired into the conditioning chain via `MiniMaxH3AddGuide`, with an outside-clip warning.
- **Stop ComfyUI** button (confirm dialog → SIGTERM the process on the configured ComfyUI port; never the server itself).
- **Start ComfyUI fallback**: launches `repo/venv/bin/python main.py --disable-pinned-memory --fp16-intermediates --fast-disk --port <port>` when no `launch.sh` exists.
- **Documentation**: `docs/usage.md` (walkthrough), `docs/architecture.md` (how it works), `docs/runs-log.md` (AI-use record schema); README restructured around the modes, features and pointers to docs.

### Changed

- README rewritten to document the current feature set and point at `docs/`.
- `server.py`: `/docs` static serving (the vendored guides shown by the builder's 📖 Guide button), `/api/stop-comfy`, a `--log` default, and a connection-robustness fix in the proxy (499 on client abort).
- `run.sh`: default ComfyUI venv path (`repo/venv/bin/python`).
- `.gitignore`: ignores `*.log`.
- UI polish: theme toggle (system/light/dark), persisted bands/filters/gallery selection, collapsible sampling/models/output bands with live summaries.

### Known limitations

- The video path has no logged runs yet — gallery/graphs exercised by the image tabs only.
- `runs.jsonl` may contain smoke-probe records with no schema fields; skip them when aggregating.
- No LICENSE file — vendored guides are MIT © MiniMax; the rest of the repo is unlicensed.
- Persisted gallery keeps the last 200 runs with graphs stripped; the full API graph lives only in the `runs.jsonl` record.

### Not in this release

- Publishing: this is a draft. Publish only after the tag points at a commit containing this work.

[v0.2.0-beta.1]: https://github.com/PyaesoneP/H3-Studio/releases/tag/v0.2.0-beta.1
