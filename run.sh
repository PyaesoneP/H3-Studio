#!/bin/bash
# Start H3 Studio with ComfyUI's Python (it already has aiohttp). Open http://127.0.0.1:8190
# Set COMFY_PY to use another interpreter with aiohttp installed.
exec "${COMFY_PY:-$HOME/comfyui/venv/bin/python}" "$(dirname "$0")/server.py" "$@"
