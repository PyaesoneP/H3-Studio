#!/usr/bin/env python3
"""H3 Studio: a local web frontend for MiniMax H3 in ComfyUI (text to image, image edit, multi-reference
edit, video). Serves static/ and proxies ComfyUI (HTTP + websocket) under /comfy so the browser stays
same-origin. Every queued run is appended to runs.jsonl (record for the AI-use declaration).
Usage  ./run.sh [--port 8190] [--comfy http://127.0.0.1:8188] [--comfy-dir ~/comfyui] [--log PATH]
"""
import argparse, asyncio, json, pathlib, subprocess, time
import aiohttp
from aiohttp import web

HERE = pathlib.Path(__file__).resolve().parent
DROP = {"host", "origin", "referer", "content-length", "transfer-encoding", "connection", "upgrade",
        "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "accept-encoding"}


def make_app(comfy, comfy_dir, log_path):
    app = web.Application(client_max_size=4 * 1024 ** 3)
    session = {}

    async def startup(_):
        session["s"] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=5))

    async def cleanup(_):
        await session["s"].close()

    async def index(_):
        return web.FileResponse(HERE / "static/index.html")

    async def ws_proxy(request):
        client = web.WebSocketResponse(max_msg_size=0)
        await client.prepare(request)
        url = comfy.replace("http", "ws", 1) + "/ws?" + request.query_string
        try:
            async with session["s"].ws_connect(url, max_msg_size=0) as upstream:
                async def pump(src, dst):
                    async for msg in src:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            await dst.send_str(msg.data)
                        elif msg.type == aiohttp.WSMsgType.BINARY:
                            await dst.send_bytes(msg.data)
                        else:
                            break
                tasks = [asyncio.create_task(pump(upstream, client)), asyncio.create_task(pump(client, upstream))]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in tasks:
                    t.cancel()
        except aiohttp.ClientError:
            pass
        await client.close()
        return client

    async def http_proxy(request):
        tail = request.match_info["tail"]
        headers = {k: v for k, v in request.headers.items() if k.lower() not in DROP}
        body = await request.read() if request.can_read_body else None
        try:
            async with session["s"].request(request.method, f"{comfy}/{tail}", params=request.query,
                                            headers=headers, data=body, allow_redirects=False) as up:
                resp = web.StreamResponse(status=up.status)
                for k, v in up.headers.items():
                    if k.lower() in ("content-type", "content-disposition", "cache-control"):
                        resp.headers[k] = v
                await resp.prepare(request)
                async for chunk in up.content.iter_chunked(1 << 16):
                    await resp.write(chunk)
                await resp.write_eof()
                return resp
        except aiohttp.ClientConnectorError:
            return web.json_response({"error": "ComfyUI is not running", "comfy": comfy}, status=502)
        except ConnectionResetError:          # browser went away mid-response (aiohttp's reset error subclasses it)
            return web.Response(status=499)

    async def log_run(request):
        rec = await request.json()
        rec["logged"] = time.strftime("%Y-%m-%d %H:%M:%S")
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return web.json_response({"ok": True, "log": str(log_path)})

    async def start_comfy(_):
        if not (comfy_dir / "launch.sh").exists():
            return web.json_response({"ok": False, "error": f"{comfy_dir}/launch.sh not found"}, status=404)
        out = (comfy_dir / "comfyui.log").open("ab")
        subprocess.Popen(["bash", "launch.sh"], cwd=comfy_dir, stdout=out, stderr=subprocess.STDOUT,
                         start_new_session=True)
        return web.json_response({"ok": True, "log": str(comfy_dir / "comfyui.log")})

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)
    app.router.add_get("/", index)
    app.router.add_static("/static", HERE / "static")
    app.router.add_get("/comfy/ws", ws_proxy)
    app.router.add_route("*", "/comfy/{tail:.*}", http_proxy)
    app.router.add_post("/api/log", log_run)
    app.router.add_post("/api/start-comfy", start_comfy)
    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument("--comfy", default="http://127.0.0.1:8188")
    ap.add_argument("--comfy-dir", default=str(pathlib.Path.home() / "comfyui"), help="used by the Start ComfyUI button")
    ap.add_argument("--log", default=str(HERE / "runs.jsonl"))
    a = ap.parse_args()
    print(f"H3 Studio on http://127.0.0.1:{a.port}  (ComfyUI {a.comfy}, log {a.log})")
    web.run_app(make_app(a.comfy.rstrip("/"), pathlib.Path(a.comfy_dir).expanduser(), pathlib.Path(a.log).expanduser()), host="127.0.0.1", port=a.port, print=None)
