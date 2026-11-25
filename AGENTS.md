# AGENTS.md

Instructions for coding agents and contributors working in this repo.

## What this repo is

H3 Studio is a local, browser-based frontend for MiniMax H3 in ComfyUI. It builds image and video
graphs, renders results in a gallery, applies a prompt builder, and logs every run as an AI-use record.

- `server.py` serves `static/` and `docs/` at `127.0.0.1:8190`, proxies ComfyUI under `/comfy`
  (HTTP and websocket), and owns the run log and Start/Stop ComfyUI.
- `static/` is the whole UI in one page (`index.html`, `app.js`, `style.css`).
- `docs/` holds vendored prompt guides (MIT © MiniMax) plus project docs (usage, architecture, runs log).
- `run.sh` execs ComfyUI's venv Python with `server.py`.

The app is meant to become a desktop app for Windows for SUTD students. The current code is
POSIX-oriented (`lsof`, `bash launch.sh`), and the desktop work starts on top of it.

## Workflow: branch, PR, merge

1. Every change, including docs, lands on a new branch. Never commit or push directly to `main`.
2. Branch names: `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, `build/<slug>`, `test/<slug>`.
3. One concern per PR. A PR carrying two unrelated changes is too big.
4. PR body: what changed, why, how to test it, and what is out of scope.
5. Commits: small, imperative mood, stating the reason, not the mechanism. Stage only the files the
   change touches. Don't `git add -A`.
6. Review the branch before requesting merge. Check the diff, not just the summary.

## Conventions and constraints

- Local-first, no telemetry. The server binds `127.0.0.1`. Do not add network calls beyond ComfyUI.
  Do not add analytics or crash reporting or any outbound reporting.
- Never commit user data. `runs.jsonl` is private and git-ignored. It holds prompts, inputs and outputs.
  Do not commit it, and do not paste its contents into a PR, issue, or doc.
- Do not bundle or redistribute model weights. Students bring their own MiniMax H3 weights. Never
  download or commit weights, and never add a link to a weights mirror.
- Preserve vendored files. `docs/prompt-guide-t2i.md` and `docs/prompt-guide-edit.md` are vendored
  verbatim (MIT © MiniMax). Keep their provenance headers. Do not rewrite or relicense them.
  Everything else is Apache-2.0 (see `LICENSE`).
- Windows-ready by design. The desktop shell must fix the POSIX-only pieces or gate them behind
  graceful fallbacks.
- No dead code or stale TODOs. If something is broken, fix it or file an issue.

## Writing rules

These apply to every prose document you write: docs, the README, PR bodies, issue comments,
commit messages, and your own words in chat.

- **No em dashes.** Use commas, periods, semicolons, or parentheses instead.
- **No emojis.** Use plain words or real icons.
- **Always use the humanizer skill** (`the-humanizer`) if it is available, before writing any
  prose. It flags AI-sounding patterns and rewrites them in a straight, natural voice.

## Running and testing

```sh
./run.sh        # execs ComfyUI's venv Python (COMFY_PY overrides)
```

Then open http://127.0.0.1:8190 (ComfyUI expected at http://127.0.0.1:8188).
Flags: `--port`, `--comfy`, `--comfy-dir`, `--log` (AI-use record path, default `./runs.jsonl`).

No tests exist yet. If you add code, add a test or say what you checked by eye. The expected
follow-up is a GitHub Actions smoke test: server boots, `/` serves, `/api/log` writes and stays
git-ignored.

## Releases

- Version lives in the tag (e.g. `v0.2.0-beta.1`), tagged from `main`.
- Draft pre-releases with `gh release create --draft --prerelease`; publish only when the pilot is happy.
- Keep `CHANGELOG.md` in sync with the tag.
