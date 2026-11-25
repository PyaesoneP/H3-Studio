# AGENTS.md — instructions for coding agents working in this repo

This file tells an agent (or a contributor) how to work in this repository. It applies to both
human contributors and agents. The short version: **nobody commits directly to `main`.**

## What this repo is

**H3 Studio** — a local, browser-based frontend for [MiniMax H3](https://github.com/MiniMax-AI/MiniMax-H3-Image)
in [ComfyUI](https://github.com/comfyanonymous/ComfyUI): text → image, image → image, multi-reference
image edit, and video generation, with a results gallery, prompt builder and an AI-use run log.

- `server.py` — aiohttp server: serves `static/`, `docs/`, proxies `/comfy/*` (HTTP + websocket) to ComfyUI,
  and owns the run log and Start/Stop ComfyUI.
- `static/` — the whole UI in one page (`index.html`, `app.js`, `style.css`).
- `docs/` — vendored prompt guides (MIT © MiniMax) plus project docs (usage, architecture, runs log).
- `run.sh` — execs ComfyUI's venv Python with `server.py`.

The app is intended to become a **desktop app for Windows** for SUTD students (Electron shell, guided
setup, students provide their own model weights, unsigned, pilot first, then wider rollout). The
`v0.2.0-beta.1` draft release covers the current working tree.

## Workflow: branch → PR → main

1. **Every change**, including docs and fixes, lands on a new branch. Never commit or push directly to `main`.
   (Exception: tag pushes for releases, and the one-time setup of this file.)
2. **Branch naming** — `feat/<slug>` · `fix/<slug>` · `docs/<slug>` · `chore/<slug>` · `build/<slug>` · `test/<slug>`.
3. **PRs are small and single-purpose** — one concern per PR. Do not bundle the "UI redesign + the docs"
   into one PR.
4. **PR body** — say what changed, why, how to test it, and what is explicitly out of scope.
5. **Commits** — small, imperative mood, stating the reason, not the mechanism. Stage only what the
   change touches; never `git add -A` blindly.
6. **Review the branch before requesting merge** — check the diff, not just the summary.

## Conventions & constraints

- **Local-first, no telemetry.** The server binds `127.0.0.1`. Do not add network calls beyond ComfyUI
  (badges in markdown files are the one exception). Do not add analytics, crash reporting or any
  outbound reporting.
- **Never commit user data.** `runs.jsonl` is private and git-ignored — it holds prompts, inputs and
  outputs. Never commit it, never paste its contents into a PR body, issue, or doc.
- **Do not bundle or redistribute model weights.** Students must bring or fetch their own MiniMax H3
  weights. Never download or commit weights, and never add a link to a weights mirror.
- **Preserve vendored files.** `docs/prompt-guide-t2i.md` and `docs/prompt-guide-edit.md` are vendored
  verbatim (MIT © MiniMax) — keep their provenance headers, do not rewrite or
  re-license them. Everything else is Apache-2.0 (see `LICENSE`).
- **Windows-ready by design.** The current code is POSIX-oriented (`lsof`, `bash launch.sh`). The desktop
  shell must fix these or gate them behind graceful fallbacks.
- **No dead code, no TODOs.** If you notice brokenness, fix or file it — do not leave it.

## Running & testing

```sh
./run.sh                     # execs ComfyUI's venv Python (COMFY_PY overrides)
# open http://127.0.0.1:8190  (ComfyUI expected at http://127.0.0.1:8188)
```

Flags: `--port` · `--comfy` · `--comfy-dir` · `--log` (AI-use record path, default `./runs.jsonl`).

There are no tests yet — if you add code, add a test or an honest note saying what was checked by eye.
CI (GitHub Actions) is the expected home for a smoke test: server boots, `/` serves, `/api/log` writes
and is git-ignored.

## Releases

- Version in the tag (e.g. `v0.2.0-beta.1`), tagged from `main`.
- Draft a pre-release with `gh release create --draft --prerelease`; publish only when the pilot is happy.
- Keep `CHANGELOG.md` in sync with the tag.
