"""07 的 TTS 异步适配：保留模型、字段和地址校验，为网络请求接入轮次取消。"""

import asyncio
import os
import sys
from pathlib import Path

import httpx2 as httpx


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "07-voice-interaction"))
from speech import _trusted_url, character_count, configuration, trim_text  # noqa: E402


async def synthesize(text, signal, *, env=None, client_factory=httpx.AsyncClient):
    signal.throw_if_aborted()
    if not isinstance(text, str) or not trim_text(text) or character_count(text) > 600:
        raise ValueError("本例每次合成 1 到 600 字符的回答。")
    config = configuration(os.environ if env is None else env)

    async def request():
        async with asyncio.timeout(60), client_factory(timeout=60, follow_redirects=False, trust_env=False) as client:
            response = await client.post(
                f"{config['origin']}/api/v1/services/aigc/multimodal-generation/generation",
                headers={"Authorization": f"Bearer {config['key']}", "Content-Type": "application/json"},
                json={"model": "qwen3-tts-flash", "input": {"text": text, "voice": "Cherry", "language_type": "Chinese"}},
            )
            if response.is_redirect:
                raise ValueError("语音服务返回了重定向，已拒绝转发请求。")
            data = response.json()
            if not response.is_success or data.get("code"):
                error = data.get("error")
                detail = data.get("message") or (error.get("message") if isinstance(error, dict) else None) or data.get("code") or "请求失败"
                raise ValueError(f"语音服务 {response.status_code}：{detail}")
            raw_url = ((data.get("output") or {}).get("audio") or {}).get("url")
            if not raw_url:
                raise ValueError("语音服务没有返回音频地址。")
            return _trusted_url(raw_url, audio=True)

    # 网络连接取消后仍检查轮次；即使供应商晚返回，也不能把旧音频交给页面。
    url = await signal.run(request())
    signal.throw_if_aborted()
    return url
