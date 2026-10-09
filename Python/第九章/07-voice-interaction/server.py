"""本机 FastAPI 服务：ASR、Agent 分析、TTS 三个独立步骤，单进程运行。"""

import asyncio
import inspect
import json
import os
import re
import time
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from analysis import analyze
from speech import synthesize, transcribe, trim_text, utf16_length


ROOT = Path(__file__).resolve().parent
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; media-src 'self' https://*.aliyuncs.com; object-src 'none'; frame-ancestors 'none'",
}


class _UploadTooLarge(Exception):
    pass


async def _parse_body(request):
    """按 MIME 读取 JSON/音频；逐块限制大小，不先无上限地读取整个上传。"""
    mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    limit = 16 * 1024 if mime == "application/json" else 2 * 1024 * 1024
    if mime not in {"application/json", "audio/webm", "audio/ogg"}:
        return None
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise _UploadTooLarge()
        body.extend(chunk)
    if mime != "application/json":
        return bytes(body)
    if not body:
        return {}
    value = json.loads(body)
    # 与原例的严格 JSON parser 一致，只接受对象/数组，不接受 JSON 字符串等原始值。
    if not isinstance(value, (dict, list)):
        raise ValueError("JSON 请求体需要是对象或数组。")
    return value


async def _invoke(service, *args):
    # 本课程的 urllib、模型 Provider 和 Docker 调用是同步函数。
    # 放入工作线程，避免阻塞事件循环，其他点击才能及时得到 409 并发提示。
    if inspect.iscoroutinefunction(service):
        return await service(*args)
    result = await run_in_threadpool(service, *args)
    return await result if inspect.isawaitable(result) else result


def create_app(services=None, *, now_ms=None):
    """服务和时钟可注入；离线验证不使用真实密钥、云端 API 或用户服务。"""
    services = {"transcribe": transcribe, "analyze": analyze, "synthesize": synthesize} if services is None else services
    now_ms = now_ms if now_ms is not None else lambda: time.time() * 1000
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    answers = {}  # 回答只临时保存在内存中，不写录音、转写或合成文件。
    lock = asyncio.Lock()  # 全局 API 请求锁，避免并发调用产生重复计费。

    @app.middleware("http")
    async def local_only(request, call_next):
        host = request.headers.get("host", "")
        if not re.fullmatch(r"(?:localhost|127\.0\.0\.1)(?::[0-9]+)?", host):
            return JSONResponse({"error": "只接受本机访问。"}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != f"http://{host}":
            return JSONResponse({"error": "不接受其他网站发起的请求。"}, status_code=403)

        acquired = False
        try:
            request.state.body = await _parse_body(request)
            path = request.url.path
            if path == "/api" or path.startswith("/api/"):
                if lock.locked():
                    response = JSONResponse({"error": "上一次请求仍在处理，请稍后再试。"}, status_code=409)
                else:
                    await lock.acquire()
                    acquired = True
                    response = await call_next(request)
            else:
                response = await call_next(request)
        except _UploadTooLarge:
            response = JSONResponse({"error": "上传内容过大，请缩短录音。"}, status_code=413)
        except Exception as error:
            response = JSONResponse({"error": str(error)}, status_code=500)
        finally:
            # 错误、校验拒绝和未知路径也释放锁，不让后续问题永久卡住。
            if acquired:
                lock.release()
        response.headers.update(SECURITY_HEADERS)
        return response

    @app.api_route("/favicon.ico", methods=["GET", "HEAD"])
    async def favicon():
        return Response(status_code=204)

    # 只开放页面需要的固定资源，不公开源码、配置或上级小节文件。
    for url, filename, mime in (
        ("/", "public/index.html", "text/html"),
        ("/app.js", "public/app.js", "text/javascript"),
        ("/style.css", "public/style.css", "text/css"),
        ("/vendor/lucide.js", "public/vendor/lucide.js", "text/javascript"),
    ):
        def static_endpoint(filename=filename, mime=mime):
            async def send():
                return FileResponse(ROOT / filename, media_type=mime)
            return send
        app.add_api_route(url, static_endpoint(), methods=["GET", "HEAD"])

    @app.post("/api/transcribe")
    async def transcribe_audio(request: Request):
        # 转写结果只返回浏览器输入框，绝不在此处触发 Agent 分析。
        text = await _invoke(services["transcribe"], request.state.body, request.headers.get("content-type"))
        return JSONResponse({"text": text})

    @app.post("/api/ask")
    async def ask(request: Request):
        body = request.state.body
        question = body.get("question") if isinstance(body, dict) else None
        if not isinstance(question, str) or not trim_text(question) or utf16_length(question) > 2000:
            return JSONResponse({"error": "请输入 1 到 2000 字符的问题。"}, status_code=400)
        result = await _invoke(services["analyze"], trim_text(question))
        answer_id = str(uuid4())
        for identity, entry in list(answers.items()):
            if entry["expiresAt"] <= now_ms():
                del answers[identity]
        if len(answers) >= 10:
            del answers[next(iter(answers))]  # 删除最早保存的回答，不改变原例的 FIFO 策略。
        answers[answer_id] = {"text": result["speechText"], "expiresAt": now_ms() + 15 * 60_000}
        return JSONResponse({**result, "answerId": answer_id})

    @app.post("/api/speak")
    async def speak(request: Request):
        body = request.state.body
        identity = body.get("answerId") if isinstance(body, dict) else None
        entry = answers.get(identity) if isinstance(identity, str) else None
        if not entry or entry["expiresAt"] <= now_ms():
            return JSONResponse({"error": "本次回答已过期或服务已重启，请重新分析。"}, status_code=410)
        # 只朗读本服务生成的回答，忽略浏览器传来的任意 text。
        # 合成成功才缓存 URL，重复点击复用；失败不伪造音频、不自动重试。
        if not entry.get("audioUrl"):
            entry["audioUrl"] = await _invoke(services["synthesize"], entry["text"])
        return JSONResponse({"audioUrl": entry["audioUrl"]})

    @app.api_route("/api", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    @app.api_route("/api/{rest:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    async def unknown_api(rest=""):
        return JSONResponse({"error": "接口不存在。"}, status_code=404)

    return app


def main():
    port = int(os.environ.get("PORT") or 5185)
    print(f"语音分析页面：http://localhost:{port}")
    print("真实转写、分析、合成会调用云端 API。请先加载你已有的环境配置；密钥只在服务端使用。")
    # 内存中的请求锁与回答缓存属于一个进程，不开启多 worker 或自动 reload。
    uvicorn.run(create_app(), host="127.0.0.1", port=port, server_header=False)


if __name__ == "__main__":
    main()
