"""调用兼容 OpenAI Chat Completions 结构的 DeepSeek API。

文件作用：
向模型传递完整对话历史和从 MCP Server 发现的 Tools。

章节定位：【配套文件】

建议阅读：
DEEPSEEK_API_KEY 只用于模型 API 鉴权；它与 MCP Server 使用的
业务 Token 完全独立。
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_API_URL = "https://api.deepseek.com/chat/completions"
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")


async def call_deepseek(
    *,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    api_key: str | None = None,
    api_url: str | None = None,
    model: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """调用 DeepSeek，并返回一条 assistant 消息。

    可注入 http_client、api_key 和 URL，离线验证因此不需要读取
    任何环境文件，也不会误发真实网络请求。
    """

    resolved_api_key = api_key or os.getenv("DEEPSEEK_API_KEY")
    if not resolved_api_key:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先完成进程环境配置")

    resolved_api_url = api_url or os.getenv(
        "DEEPSEEK_BASE_URL",
        DEFAULT_API_URL,
    )
    request_body = {
        "model": model or os.getenv("DEEPSEEK_MODEL", MODEL),
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "thinking": {"type": "disabled"},
        "temperature": 0.1,
    }
    headers = {
        "Authorization": f"Bearer {resolved_api_key}",
        "Content-Type": "application/json",
    }

    owns_client = http_client is None
    client = http_client or httpx.AsyncClient(timeout=60)
    try:
        response = await client.post(
            resolved_api_url,
            headers=headers,
            json=request_body,
        )
    finally:
        if owns_client:
            await client.aclose()

    try:
        data = response.json()
    except ValueError as error:
        raise RuntimeError(
            f"DeepSeek 返回了无效 JSON：HTTP {response.status_code}"
        ) from error

    if not response.is_success:
        raise RuntimeError(
            f"DeepSeek 调用失败：{response.status_code} "
            f"{data}"
        )

    choices = data.get("choices") if isinstance(data, dict) else None
    message = choices[0].get("message") if choices else None
    if not isinstance(message, dict):
        raise RuntimeError("DeepSeek 没有返回有效消息")
    return message
