"""总导演委派独立的剧情设计师，核对工具轨迹与最终文件。"""

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

from agent_trace import Trace, TraceMiddleware, message_text, print_main_messages, value


WORKSPACE_DIR = Path(__file__).resolve().parent / "workspace"
OUTPUT_PATH = "/game/branch-outline.md"
REQUIRED_READS = [
    "/skills/branch-story-design/SKILL.md",
    "/skills/branch-story-design/references/outline-template.md",
    "/game/world.md",
    OUTPUT_PATH,
]
USER_TASK = (
    "请根据 /game/world.md，为失联太空站游戏设计一个两难处境，\n"
    "提供两个有不同后果的选择和对应结局。\n"
    f"将 Markdown 大纲保存到 {OUTPUT_PATH}。"
)


def verify_run(result: dict[str, Any], trace: Trace, workspace_dir: Path) -> tuple[Path, str]:
    """验证委派、子 Agent 读取、消息隔离和最终文件。"""

    # 总导演必须通过 task 工具委派给剧情设计师。
    delegated = any(
        call["actor"] == "story-director"
        and call["name"] == "task"
        and call["args"].get("subagent_type") == "plot-designer"
        and call["ok"]
        for call in trace.calls
    )
    child_calls = [call for call in trace.calls if call["actor"] == "plot-designer"]

    # 子 Agent 必须读过 Skill、模板、世界观和最终输出文件。
    for path in REQUIRED_READS:
        if not any(
            call["name"] == "read_file"
            and call["args"].get("file_path") == path
            and call["ok"]
            for call in child_calls
        ):
            raise RuntimeError(f"剧情设计师没有成功读取 {path}，请核对调用记录。")

    if not delegated:
        raise RuntimeError("本轮没有完成预期的剧情设计师委派。")

    # 主 Agent 只看到 task 返回的报告，不能出现子 Agent 内部 ToolMessage。
    child_ids = {call["id"] for call in child_calls}
    if any(value(message, "tool_call_id") in child_ids for message in result["messages"]):
        raise RuntimeError("主 Agent messages 中出现了子 Agent 内部工具结果。")
    print("\n子 Agent 的内部 ToolMessage 是否进入总导演 messages：否")

    # 虚拟路径映射到本小节的 Workspace；空文件不算交付。
    disk_path = workspace_dir / OUTPUT_PATH.lstrip("/")
    content = disk_path.read_text(encoding="utf-8")
    if not content.strip():
        raise RuntimeError("交付文件为空。")
    return disk_path, content


async def run() -> None:
    """创建总导演及剧情设计师，将用户需求交给模型委派和交付。"""

    # 检查模型调用所需的 API Key；程序本身不读取环境文件。
    if not os.getenv("DEEPSEEK_API_KEY"):
        raise RuntimeError("缺少 DEEPSEEK_API_KEY，请先配置模型 API Key。")

    # 同一模型供主、子 Agent 推理；数值与 Node 版一致。
    model = ChatDeepSeek(
        model=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        temperature=0,
        max_retries=1,
        timeout=120,
    )

    # Workspace 保存世界观、Skill 与最终产物，主子 Agent 共用同一后端。
    backend = FilesystemBackend(root_dir=WORKSPACE_DIR, virtual_mode=True)
    trace = Trace()

    # 剧情设计师只负责具体设计；isolated 不共享总导演的消息历史。
    plot_designer = {
        "name": "plot-designer",
        "description": "根据已有世界观设计剧情分支和不同结局，将 Markdown 大纲写入指定文件。",
        "system_prompt": """你是互动剧情游戏的剧情设计师。
按照适用 Skill 完成收到的子任务，读取世界观并遵守其中的限制。
文件已经存在时，先读取，再根据本次任务决定修改或复用，完成后重新读取核对。
最终只返回交付文件路径和两个分支的简短说明，报告控制在 150 字以内，不要返回大纲全文。""",
        "mode": "isolated",
        "skills": ["/skills/"],
        "permissions": [
            # 只允许写最终文件；世界观、Skill 和模板保持只读。
            FilesystemPermission(operations=["write"], paths=[OUTPUT_PATH], mode="allow"),
            FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"),
        ],
        "middleware": [TraceMiddleware("plot-designer", trace)],
    }

    # 总导演负责委派和汇报，不直接创作，也不能写 Workspace 文件。
    director = create_deep_agent(
        name="story-director",
        model=model,
        backend=backend,
        subagents=[plot_designer],
        system_prompt="""你是互动剧情制作的总导演。本次案例只负责委派和汇报。
使用 task 工具委派给 plot-designer。description 简洁保留用户的完整创作要求、世界观路径和交付文件路径。
剧情设计师会自行读取世界观和 Skill；你直接委派，无需调用文件工具，无需增加剧情细节或另一套设计步骤。
收到交付报告后，向用户简短说明交付位置和分支区别。""",
        permissions=[FilesystemPermission(operations=["write"], paths=["/**"], mode="deny")],
        middleware=[TraceMiddleware("story-director", trace)],
    )

    print("本次用户任务：\n", USER_TASK)

    # recursion_limit 防止无限循环；wait_for 把整次任务限制为 5 分钟。
    result = await asyncio.wait_for(
        director.ainvoke(
            {"messages": [{"role": "user", "content": USER_TASK}]},
            {"recursion_limit": 40},
        ),
        timeout=300,
    )

    print_main_messages(result["messages"])
    print("\n总导演最终回答：\n", message_text(result["messages"][-1]))

    disk_path, content = verify_run(result, trace, WORKSPACE_DIR)
    print("\n实际文件：", disk_path)
    print("\n大纲正文：\n", content)


def main() -> None:
    try:
        asyncio.run(run())
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
