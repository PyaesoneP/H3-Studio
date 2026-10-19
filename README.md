# H3 Studio

Local web frontend for MiniMax H3 in ComfyUI (default `~/comfyui`).

```
./run.sh          # then open http://127.0.0.1:8190
```

`run.sh` uses ComfyUI's venv Python, so nothing needs installing. If ComfyUI is not running, the header shows a **Start ComfyUI** button that runs `~/comfyui/launch.sh`.

| Tab | ComfyUI graph |
|---|---|
| Text → Image | H3 Models → H3 LoRA chain → H3 Text to Image → H3 Render Image → Save Image |
| Image → Image | same, with H3 Image Edit and `<Picture 1>` |
| Multi-image → Image | H3 Image Edit with up to 8 extra references (`references.reference_image_N`) |
| Video | UNETLoader/GGUF → LoRAs → optional sigma shift → MiniMax H3 Image to Video (text / first / first+last) or Reference to Video (images, videos with their soundtrack, audio) → keyframe guides (MiniMaxH3AddGuide) → SamplerCustomAdvanced → VAE decode video + audio → Create Video → Save Video |

- Option lists (models, LoRAs, samplers, schedulers, aspect ratios) are read live from ComfyUI `/object_info`.
- Every finished or failed run is appended to `runs.jsonl` here with its prompt, inputs, outputs, settings and full API graph (an AI-use record). Point it at a project with `--log`, e.g. `./run.sh --log ~/iDea/working/h3_studio/runs.jsonl`.
- Flags: `--port`, `--comfy` (ComfyUI URL), `--comfy-dir` (folder with `launch.sh`, for the Start button), `--log`. `COMFY_PY` overrides the Python used by `run.sh`.
- **API JSON** shows or downloads the exact graph, so a run can be repeated from a script.
- On a result card: send it to Edit, to the references, or to the first or last frame; **↺ Settings** restores every setting of that run. You can also drag a result into any drop zone or paste images with Ctrl+V.
