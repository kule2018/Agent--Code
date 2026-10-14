"""沿用 03 的模型配置，额外记录实际请求正文、返回消息与原始 usage。"""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request

from scoring import ModelService, parse_json


class TracedModelService(ModelService):
    def __init__(self, trace, *, environment=None, open_request=None):
        super().__init__(environment=environment, open_request=open_request)
        self.trace = trace

    def complete(self, role, request):
        self.assert_configured()
        if role not in ("agent", "judge"):
            raise ValueError("模型角色须为 agent 或 judge。")
        # 03 的请求接口只包含这三个字段；只记录白名单正文，不包含客户端和认证头。
        params = {key: request[key] for key in ("messages", "tools", "response_format") if key in request}
        params.update({"model": self.settings()[role], "stream": False, "max_tokens": 1600,
                       "temperature": 0, "thinking": {"type": "disabled"}})

        def send():
            base_url = self.environment.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
            http_request = Request(
                base_url.rstrip("/") + "/chat/completions",
                data=json.dumps(params, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"),
                headers={"Authorization": f"Bearer {self.environment['DEEPSEEK_API_KEY']}",
                         "Content-Type": "application/json"}, method="POST",
            )
            try:
                # timeout 单位是秒；与原例 45_000 毫秒一致，不进行自动重试。
                with self.open_request(http_request, timeout=45) as response:
                    body = parse_json(response.read().decode("utf-8"))
            except HTTPError as error:
                error.close()
                raise RuntimeError(f"模型请求失败：HTTP {error.code}") from error
            except (URLError, TimeoutError) as error:
                raise RuntimeError("模型请求失败：网络连接异常或超时。") from error
            if not isinstance(body, dict):
                raise ValueError("模型响应须为 JSON 对象。")
            choices = body.get("choices")
            choice = choices[0] if isinstance(choices, list) and choices else {}
            if not isinstance(choice, dict):
                raise ValueError("模型响应中的 choice 须为对象。")
            return {"model": body.get("model"), "message": choice.get("message"),
                    "finishReason": choice.get("finish_reason"), "usage": body.get("usage")}

        result = self.trace.capture(f"{role}.model", "model", params, send)
        # 与原例一样，完整性检查在 capture 之后：HTTP 正常返回不等于答案完整。
        # 截断仍保留原始 message/finishReason/usage，异常由 Agent 或评分器继续记录。
        if not isinstance(result["message"], dict) or result["finishReason"] not in ("stop", "tool_calls"):
            reason = result["finishReason"] if result["finishReason"] is not None else "empty_choices"
            raise ValueError(f"模型没有完整返回：{reason}")
        return result["message"]
