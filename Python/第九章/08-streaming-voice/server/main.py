"""本机 FastAPI + 原生 WebSocket；独立 Vue 前端仍由本节自己的 Vite 提供。"""

import os
import re
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket

from .voice_gateway import VoiceGateway


def create_app(gateway=None, *, env=None):
    env = os.environ if env is None else env
    web_port = int(env.get("WEB_PORT") or 5186)
    origins = {f"http://localhost:{web_port}", f"http://127.0.0.1:{web_port}"}
    gateway = VoiceGateway() if gateway is None else gateway

    @asynccontextmanager
    async def lifespan(app):
        yield
        await gateway.shutdown()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    @app.websocket("/voice")
    async def voice(socket: WebSocket):
        # 在 accept 前拒绝其他网站/任意 Host，防止网页借用本机 Key 发付费请求。
        if (socket.headers.get("origin") not in origins
                or not re.fullmatch(r"(?:localhost|127\.0\.0\.1)(?::[0-9]+)?", socket.headers.get("host", ""))):
            await socket.close(code=1008)
            return
        await gateway.handle(socket)

    return app


def main():
    port = int(os.environ.get("PORT") or 4316)
    web_port = int(os.environ.get("WEB_PORT") or 5186)
    print(f"语音服务：http://127.0.0.1:{port}；页面：http://localhost:{web_port}")
    print("真实识别、分析和合成会调用云端 API；请先在终端加载已有环境配置。")
    uvicorn.run(create_app(), host="127.0.0.1", port=port, ws="websockets-sansio",
                ws_max_size=32 * 1024, server_header=False)


if __name__ == "__main__":
    main()
