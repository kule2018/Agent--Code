"""同一个 Deep Agent 处理剧情任务与普通问答，观察 Skill 是否按需读取。"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from deepagents.middleware.filesystem import FilesystemPermission
from langchain_deepseek import ChatDeepSeek


WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"
OUTPUT_PATH = "/game/branch-outline.md"
SKILL_PATH = "/skills/branch-story-design/SKILL.md"
TEMPLATE_PATH = "/skills/branch-story-design/references/outline-template.md"

TASKS = {
    "story": (
        "请根据 /game/world.md，为失联太空站游戏设计一个两难处境，\n"
        "提供两个有不同后果的选择和对应结局。\n"
        f"将 Markdown 大纲保存到 {OUTPUT_PATH}。"
    ),
    "chat": "2 + 3 等于多少？直接给出答案。",
}


def field(value: Any, name: str, default: Any = None) -> Any:
    """LangChain 消息是对象；测试数据也可以使用等价字典。"""

    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def message_text(message: Any) -> str:
    """统一提取 Message 正文，供终端展示和工具结果检查使用。"""

    content = field(message, "content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "text"
    )


def collect_tool_calls(messages: list[Any]) -> list[dict[str, Any]]:
    """按 Tool Call ID 配对请求与返回，避免把一次失败的读取当成已加载。"""

    results = {
        field(message, "tool_call_id"): message
        for message in messages
        if field(message, "tool_call_id")
    }
    calls: list[dict[str, Any]] = []
    for message in messages:
        for call in field(message, "tool_calls", []) or []:
            result = results.get(field(call, "id"))
            text = message_text(result)
            args = field(call, "args", {}) or {}
            calls.append({
                "name": field(call, "name"),
                "path": field(args, "file_path"),
                "ok": result is not None
                and field(result, "status") != "error"
                and not text.lower().startswith("error:"),
                "text": text,
            })
    return calls


def discover_skill_names(backend: FilesystemBackend) -> list[str]:
    """仅读取 Skill 前置信息供终端展示，不把正文加入模型输入。"""

    listing = backend.ls("/skills/")
    if listing.error:
        raise RuntimeError(listing.error)
    names: list[str] = []
    for entry in listing.entries or []:
        if not entry.get("is_dir"):
            continue
        # 本节的 Skill 前置信息恰好占前四行；正文仍由 Agent 按需读取。
        path = f"{entry['path'].rstrip('/')}/SKILL.md"
        header = backend.read(path, limit=4)
        content = header.file_data.get("content") if header.file_data else None
        if header.error or not isinstance(content, str):
            continue
        lines = content.splitlines()
        if len(lines) != 4 or lines[0] != "---" or lines[-1] != "---":
            continue
        for line in lines[1:-1]:
            if line.startswith("name:"):
                name = line.partition(":")[2].strip()
                if name:
                    names.append(name)
                break
    return names


def print_run(
    result: dict[str, Any], calls: list[dict[str, Any]], skill_names: list[str]
) -> None:
    """展示真正执行过的工具，以及本轮是否读入 Skill 正文和模板。"""

    # Python 的 ainvoke 输出只包含 messages，不返回内部的 skills_metadata。
    print("\n发现的 Skill：", ", ".join(skill_names) or "无")
    print("\n本次工具调用：")
    if not calls:
        print("无")
    for call in calls:
        path = f" {call['path']}" if call["path"] else ""
        print(f"{call['name']}{path}：{'成功' if call['ok'] else '失败'}")
        if not call["ok"]:
            print(call["text"])
    for label, path in (("Skill 正文", SKILL_PATH), ("大纲模板", TEMPLATE_PATH)):
        read = any(
            call["name"] == "read_file" and call["path"] == path and call["ok"]
            for call in calls
        )
        print(f"\n本轮是否读取 {label}：{'是' if read else '否'}")
    messages = result.get("messages") or []
    print("\n最终回答：\n", message_text(messages[-1]) if messages else "")


def verify_story(calls: list[dict[str, Any]], workspace_dir: Path) -> tuple[Path, str, bool]:
    """核对本轮保存或复核动作，并检查最终大纲确实落盘且非空。"""

    # Python SDK 的 write_file 成功消息是 "Updated file ..."，与 Node 版不同。
    saved = any(
        call["path"] == OUTPUT_PATH
        and call["ok"]
        and (
            (
                call["name"] == "write_file"
                and call["text"].strip() == f"Updated file {OUTPUT_PATH}"
            )
            or (
                call["name"] == "edit_file"
                and call["text"].startswith("Successfully replaced ")
                and f"'{OUTPUT_PATH}'" in call["text"]
            )
        )
        for call in calls
    )

    # Agent 可以只读取已有大纲；本轮至少要有保存或复核动作。
    reviewed = any(
        call["name"] == "read_file" and call["path"] == OUTPUT_PATH and call["ok"]
        for call in calls
    )
    if not saved and not reviewed:
        raise RuntimeError("本轮没有保存或复核大纲，请检查上面的调用记录。")

    # 将虚拟路径转换为真实磁盘路径，并读取最终文件内容。
    disk_path = workspace_dir / OUTPUT_PATH.lstrip("/")
    content = disk_path.read_text(encoding="utf-8")
    if not content.strip():
        raise RuntimeError("大纲文件为空。")
    return disk_path, content, saved


async def run(mode: str = "story") -> None:
    """从命令选择任务，交给同一个 Deep Agent 配置完成。"""

    # 当前示例只支持 story 和 chat 两种任务。
    if mode not in TASKS:
        raise ValueError("仅支持 story 和 chat 两个命令。")

    # DeepSeek API Key 是模型调用的必要配置；本程序不加载环境文件。
    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先配置模型 API Key。")

    # 创建 DeepSeek 模型，限制重试次数和单次模型请求超时时间。
    model = ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=1,
        timeout=120,
    )

    # 把本小节自己的 workspace 作为 Agent 的文件系统工作区。
    backend = FilesystemBackend(root_dir=WORKSPACE_DIR, virtual_mode=True)

    # story 和 chat 共用同一套模型、Workspace、Skills 和权限配置。
    agent = create_deep_agent(
        model=model,
        backend=backend,
        skills=["/skills/"],
        system_prompt="你是互动剧情制作助手。当前任务由你直接完成，按用户要求交付。",
        permissions=[
            # 本例只允许修改最终交付文件，世界观、Skill 和模板保持只读。
            FilesystemPermission(operations=["write"], paths=[OUTPUT_PATH], mode="allow"),
            FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
        ],
    )

    print("本次任务：\n", TASKS[mode])

    # recursion_limit 限制 Agent 最大递归次数；wait_for 限制整次任务至多 5 分钟。
    result = await asyncio.wait_for(
        agent.ainvoke(
            {"messages": [{"role": "user", "content": TASKS[mode]}]},
            {"recursion_limit": 30},
        ),
        timeout=300,
    )

    # 从完整消息记录提取工具调用，检查 Agent 实际执行过程。
    calls = collect_tool_calls(result["messages"])
    print_run(result, calls, discover_skill_names(backend))

    if mode == "story":
        # 剧情任务还需要核对最终文件交付；普通问答不生成文件。
        disk_path, content, saved = verify_story(calls, WORKSPACE_DIR)
        if not saved:
            print("\n本轮只读取了已有大纲，没有重新写入文件。")
        print("\n实际文件：", disk_path)
        print("\n大纲正文：\n", content)


def main() -> None:
    # 读取命令行参数，默认执行 story 任务。
    mode = sys.argv[1] if len(sys.argv) > 1 else "story"
    try:
        asyncio.run(run(mode))
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
