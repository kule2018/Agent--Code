"""标准库 Chat Completions 客户端；不加载环境文件，不重试或打印认证信息。"""

import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from contracts import TEXT_WHITESPACE, json_text, parse_json


class ModelService:
    def __init__(self, *, environment=None, open_request=None):
        self.environment = os.environ if environment is None else environment
        self.open_request = urlopen if open_request is None else open_request

    def assert_configured(self):
        key = self.environment.get("DEEPSEEK_API_KEY")
        if not key or not key.strip(TEXT_WHITESPACE):
            raise ValueError("请先向当前进程加载 DEEPSEEK_API_KEY，运行方式见 README.md。")

    def settings(self):
        agent = self.environment.get("DEEPSEEK_MODEL") or "deepseek-flash"
        return {"agent": agent, "judge": self.environment.get("JUDGE_MODEL") or agent}

    def complete(self, role, request):
        self.assert_configured()
        if role not in ("agent", "judge"):
            raise ValueError("模型角色须为 agent 或 judge。")
        params = {**request, "model": self.settings()[role], "stream": False,
                  "temperature": 0, "max_tokens": 1600, "thinking": {"type": "disabled"}}
        base_url = self.environment.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
        http_request = Request(base_url.rstrip("/") + "/chat/completions",
            data=json_text(params).encode("utf-8"), method="POST",
            headers={"Authorization": f"Bearer {self.environment['DEEPSEEK_API_KEY']}", "Content-Type": "application/json"})
        try:
            # urllib 使用秒，原例为 45_000 毫秒；不进行自动重试。
            with self.open_request(http_request, timeout=45) as response:
                completion = parse_json(response.read().decode("utf-8"))
        except HTTPError as error:
            error.close()
            raise RuntimeError(f"模型请求失败：HTTP {error.code}") from error
        except (URLError, TimeoutError) as error:
            raise RuntimeError("模型请求失败：网络连接异常或超时。") from error
        choices = completion.get("choices") if isinstance(completion, dict) else None
        choice = choices[0] if isinstance(choices, list) and choices else {}
        reason = choice.get("finish_reason") if isinstance(choice, dict) else None
        if reason not in ("stop", "tool_calls"):
            raise ValueError(f"模型没有完整返回：{reason or 'empty_choices'}")
        if not isinstance(choice.get("message"), dict):
            raise ValueError("模型没有返回有效消息。")
        return choice["message"]
