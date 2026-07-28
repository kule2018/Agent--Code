"""DeepSeek Chat Completions 客户端。"""

import json
import os
import time
import urllib.error
import urllib.request

API_URL = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/chat/completions"
MODEL = os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-flash"


async def call_deepseek(*, messages, tools, env=None, transport=None):
    """调用 DeepSeek Chat Completions。

    当前案例关闭思考模式，只观察模型提出的 Action、
    工具返回的 Observation 和最终回答。
    """

    env = env or os.environ
    api_url = env.get("DEEPSEEK_BASE_URL") or API_URL
    model = env.get("DEEPSEEK_MODEL") or MODEL
    api_key = env.get("DEEPSEEK_API_KEY")

    if not api_key:
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。")

    started_at = time.perf_counter()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": messages,
        "tools": tools,
        "tool_choice": "auto",
        "thinking": {
            "type": "disabled",
        },
        "temperature": 0.1,
    }

    if transport is None:
        status, data = _post_json(api_url, headers, payload)
    else:
        status, data = transport(api_url, headers, payload)

    if status < 200 or status >= 300:
        raise RuntimeError(f"DeepSeek 调用失败：{status} {json.dumps(data, ensure_ascii=False)}")

    choices = data.get("choices") or []
    choice = choices[0] if choices else None

    if not choice or not choice.get("message"):
        raise RuntimeError(f"DeepSeek 没有返回有效消息：{json.dumps(data, ensure_ascii=False)}")

    return {
        "message": choice["message"],
        "finishReason": choice.get("finish_reason"),
        "latencyMs": round((time.perf_counter() - started_at) * 1000),
        "usage": data.get("usage"),
    }


def _post_json(api_url, headers, payload):
    request = urllib.request.Request(
        api_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8")

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {"message": body}

        return error.code, data
