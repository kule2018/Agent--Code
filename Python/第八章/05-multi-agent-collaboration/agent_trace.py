"""记录总导演与剧情设计师的模型输入和工具调用，不参与调度。"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any

from langchain.agents.middleware import AgentMiddleware


def value(obj: Any, name: str, default: Any = None) -> Any:
    """兼容 LangChain 消息对象与测试中的同结构字典。"""

    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)


def message_text(message: Any) -> str:
    """提取 Message 中的文本，兼容字符串和文本内容块。"""

    content = value(message, "content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def tool_result(result: Any, call_id: str) -> Any:
    """普通工具直接返回 ToolMessage；task 通过 Command.update 携带它。"""

    update = value(result, "update")
    messages = value(update, "messages")
    if isinstance(messages, list):
        return next(
            (message for message in messages if value(message, "tool_call_id") == call_id),
            None,
        )
    return result if value(result, "tool_call_id") == call_id else None


@dataclass
class Trace:
    """仅保存本次运行轨迹；不会改变 Agent 的上下文或委派逻辑。"""

    inputs: dict[str, list[dict[str, str]]] = field(default_factory=dict)
    calls: list[dict[str, Any]] = field(default_factory=list)


class TraceMiddleware(AgentMiddleware):
    """分别记录每个 Agent 的首次输入和实际工具结果。"""

    def __init__(self, actor: str, trace: Trace) -> None:
        self.actor = actor
        self.trace = trace

    async def abefore_model(self, state: dict[str, Any], runtime: Any) -> None:
        if self.actor in self.trace.inputs:
            return
        messages = [
            {"type": value(message, "type", ""), "content": message_text(message)}
            for message in state.get("messages", [])
        ]
        self.trace.inputs[self.actor] = messages
        print(f"\n[{self.actor}] 首次模型调用，messages 数量：{len(messages)}")
        if self.actor == "plot-designer":
            print("剧情设计师收到的任务：\n", messages[-1]["content"] if messages else "")

    async def awrap_tool_call(self, request: Any, handler: Any) -> Any:
        tool_call = request.tool_call
        call_id = tool_call["id"]
        name = tool_call["name"]
        args = tool_call.get("args") or {}
        call = {
            "actor": self.actor,
            "id": call_id,
            "name": name,
            "args": args,
            "ok": False,
            "text": "",
        }
        self.trace.calls.append(call)
        path = f" {args['file_path']}" if args.get("file_path") else ""
        print(f"\n[{self.actor}] 调用 {name}{path}")
        if name == "task":
            print("委派参数：\n", json.dumps(args, ensure_ascii=False, indent=2))

        try:
            result = await handler(request)
            message = tool_result(result, call_id)
            call["text"] = message_text(message)
            call["ok"] = (
                message is not None
                and value(message, "status") != "error"
                and not call["text"].lower().startswith("error:")
            )
            print(f"[{self.actor}] {name}：{'成功' if call['ok'] else '失败'}")
            if name == "task" or not call["ok"]:
                print(call["text"])
            return result
        except Exception as error:
            call["text"] = str(error)
            print(f"[{self.actor}] {name}：{error}", file=sys.stderr)
            raise


def print_main_messages(messages: list[Any]) -> None:
    """按消息类型展示主 Agent 历史，不混入子 Agent 的内部调用。"""

    print("\n总导演最终的 messages：")
    for message in messages:
        tool_calls = value(message, "tool_calls") or []
        if tool_calls:
            names = ", ".join(value(call, "name", "") for call in tool_calls)
            print(f"AIMessage：调用 {names}")
        elif value(message, "tool_call_id"):
            print(f"ToolMessage：{value(message, 'name')} 返回结果")
        else:
            print("HumanMessage：用户任务" if value(message, "type") == "human" else "AIMessage：回复正文")
