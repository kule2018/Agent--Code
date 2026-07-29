"""DeepSeek Chat Completions 客户端。"""

import json
import os
import time
import urllib.error
import urllib.request

API_URL = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com/chat/completions"
MODEL = os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-flash"


async def call_deepseek(*, messages, json_output=False, max_tokens=2400, env=None, transport=None):
    """调用 DeepSeek Chat Completions。

    Planner 和 Replanner 使用 JSON Output，最终结论使用普通文本输出。
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
        "thinking": {
            "type": "disabled",
        },
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }

    if json_output:
        payload["response_format"] = {
            "type": "json_object",
        }

    if transport is None:
        status, data = _post_json(api_url, headers, payload)
    else:
        status, data = transport(api_url, headers, payload)

    if status < 200 or status >= 300:
        raise RuntimeError(f"DeepSeek 调用失败：{status} {json.dumps(data, ensure_ascii=False)}")

    choices = data.get("choices") or []
    message = choices[0].get("message") if choices else None

    if not message:
        raise RuntimeError(f"DeepSeek 没有返回有效消息：{json.dumps(data, ensure_ascii=False)}")

    return {
        "message": message,
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
