# `runs.jsonl`: the run record

H3 Studio appends one JSON object per line to a log file on every finished or failed run. This is the **AI-use declaration**: a machine-readable record of what was generated, with which inputs, under which settings, and the exact API graph that was sent to ComfyUI.

The server adds the `logged` timestamp and owns the file (`--log`, default `./runs.jsonl`, created with parent directories). The UI posts the record fire-and-forget; a failed POST is silent, so the file is the durable record. It is **git-ignored**: it contains prompts and outputs, so point it at a project directory and keep it out of version control (`./run.sh --log ~/your-project/runs.jsonl`).

## Record schema

| Field | Type | Notes |
|---|---|---|
| `prompt_id` | string (uuid) | The ComfyUI run id |
| `status` | `"done"` \| `"error"` | missing on smoke probes |
| `error` | string | e.g. a missing text-encoder file, or `"Interrupted"` |
| `mode` | `t2i` \| `i2i` \| `multi` \| `video` | |
| `video_mode` | `t2v` \| `first` \| `firstlast` \| `ref` \| `null` | `null` for non-video |
| `prompt` | string | the exact prompt sent |
| `seed` | int | |
| `prompt_source` | `"builder"` \| `"raw"` | `"builder"` means the prompt was assembled by the prompt builder; absent in legacy records |
| `settings` | string | e.g. `2048×1536 · 6 steps · euler/simple` (video: `<vmode> · <WxH> · <N>f · steps · sampler/scheduler`) |
| `model` | string | diffusion model filename |
| `loras` | string[] | e.g. `["minimax_h3_turbo_v4 @0.38"]`; may be empty |
| `run_info` | string | joined text output from the graph (may be empty) |
| `inputs` | string[] | keyed by slot group: `i2i:<name>`, `multi:<name>`, `first:<name>`, `last:<name>`, `refImg:<name>`, `refVid:<name>`, `refAud:<name>`, `guide@<frame>:<name>` |
| `outputs` | string[] | `SaveImage`/`CreateVideo` filenames (`[output]` suffix stripped) |
| `seconds` | string | elapsed seconds, e.g. `"151.3"` |
| `graph` | object | the full ComfyUI API graph: nested `1: {class_type, inputs}, 2: …` |
| `logged` | string | `YYYY-MM-DD HH:MM:SS`, added server-side |

## Example (illustrative, neutral)

```json
{"prompt_id": "a1b2c3d4-…", "status": "done", "error": "", "mode": "t2i", "video_mode": null,
 "prompt": "A naturalistic photograph of a quiet bakery counter…", "seed": 42,
 "prompt_source": "builder",
 "settings": "2048×1536 · 6 steps · euler/simple",
 "model": "minimax_h3_image_pruned.safetensors", "loras": [],
 "run_info": "", "inputs": [], "outputs": ["h3studio/img_00001_.png"],
 "seconds": "151.3",
 "graph": {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_image_pruned.safetensors", "weight_dtype": "default"}}, "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "…", "type": "minimax", "device": "default"}}},
 "logged": "2026-11-25 10:00:00"}
```

## Parsing notes

- The whole graph is stored, so any run can be repeated from a script with `POST /comfy/prompt`. That is what `API JSON` downloads.
- Some records are smoke probes (`{ "msg": "ui smoke probe", "logged": … }`) with no schema fields; skip them when aggregating.
- `inputs` uses the slot group as prefix, e.g. `i2i:photo.jpg` or `guide@0:audio.wav`; `outputs` is always filenames under the ComfyUI output directory, not absolute paths.
- A run can legitimately have `status: "error"` with empty `outputs`. That is the record of a failed run, not a missing one.
