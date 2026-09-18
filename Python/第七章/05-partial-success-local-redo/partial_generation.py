"""部分成功与局部重做案例的命令行入口。"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from langgraph.checkpoint.postgres import PostgresSaver

from workflow import create_partial_generation_workflow


SUPPORTED_MODES = {
    "reset",
    "start",
    "status",
    "continue",
    "revise-page",
    "outline-v2",
    "export",
}
THREAD_ID = "presentation-partial-generation-1001"


def get_postgres_uri() -> str:
    """获取课程案例使用的 PostgreSQL 连接地址。"""

    return os.getenv(
        "POSTGRES_URI",
        "postgresql://agent_course:agent_course@localhost:5435/agent_partial_generation",
    )


def create_config() -> dict[str, Any]:
    """返回本案例固定使用的 Thread Config。"""

    return {"configurable": {"thread_id": THREAD_ID}}


def print_status(snapshot: Any) -> None:
    """用更容易观察的格式打印页面任务和产物。"""

    values = getattr(snapshot, "values", {})

    print(f"\n演示文稿：{values.get('presentationId')}")
    print(f"当前大纲：Outline v{values.get('outlineVersion')}")
    print(f"任务状态：{values.get('runStatus')}")
    print("\n页面任务：")

    for task in values.get("pageTasks", []):
        print(
            f"- [{task['status']}] {task['pageId']} {task['title']} | "
            f"Outline v{task['outlineVersion']} | 页面 r{task['pageRevision']} | "
            f"尝试 {task['attempts']} 次"
        )
        if task.get("currentArtifactId"):
            print(f"  当前产物：{task['currentArtifactId']}")
        if task.get("lastError"):
            print(f"  原因：{task['lastError']}")

    print(f"\n已保存产物：{len(values.get('artifacts', []))} 个")
    if values.get("exportResult"):
        print("\n导出校验：")
        print(json.dumps(values["exportResult"], ensure_ascii=False, indent=2))


def invoke_existing(
    graph: Any,
    config: dict[str, Any],
    operation: str,
    **extra: Any,
) -> Any:
    """读取保存的完整 State，并开始一轮新的操作。"""

    snapshot = graph.get_state(config)
    values = getattr(snapshot, "values", {})

    if not values.get("presentationId"):
        raise RuntimeError("没有找到页面制作任务，请先执行 uv run python partial_generation.py start。")

    return graph.invoke(
        {
            **values,
            "operation": operation,
            "targetPageId": None,
            "changeRequest": None,
            **extra,
        },
        config,
    )


def start_workflow(graph: Any, config: dict[str, Any]) -> None:
    """第一次生成全部页面，其中第三页会模拟失败。"""

    print("========== 第一次生成全部页面 ==========")
    graph.invoke(
        {"presentationId": "PRESENTATION-1001", "operation": "initial"},
        config,
    )
    print_status(graph.get_state(config))


def continue_workflow(graph: Any, config: dict[str, Any]) -> None:
    """只继续失败、缺失或者已经失效的页面。"""

    print("========== 继续未完成页面 ==========")
    invoke_existing(graph, config, "continue")
    print_status(graph.get_state(config))


def revise_single_page(graph: Any, config: dict[str, Any]) -> None:
    """只修改第二页，并保留其他页面当前产物。"""

    print("========== 只修改 page-2 ==========")
    invoke_existing(
        graph,
        config,
        "revise_page",
        targetPageId="page-2",
        changeRequest="突出 Agent 的风险控制与人工审核能力。",
    )
    print_status(graph.get_state(config))


def publish_outline_v2(graph: Any, config: dict[str, Any]) -> None:
    """发布新版大纲，让上一版本生成的页面统一失效。"""

    print("========== 发布 Outline v2 ==========")
    invoke_existing(graph, config, "publish_outline")
    print_status(graph.get_state(config))


def export_presentation(graph: Any, config: dict[str, Any]) -> None:
    """导出以前校验页面产物是否完整且版本一致。"""

    print("========== 校验并导出演示文稿 ==========")
    invoke_existing(graph, config, "export")
    print_status(graph.get_state(config))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else None

    if mode not in SUPPORTED_MODES:
        raise ValueError(
            "请通过 uv run python partial_generation.py reset、start、status、continue、"
            "revise-page、outline-v2 或 export 运行案例。"
        )

    config = create_config()

    # PostgresSaver 会把每一步 State 写入 PostgreSQL。
    # 因此 start、status、continue 等命令可以在不同进程中连续执行。
    with PostgresSaver.from_conn_string(get_postgres_uri()) as checkpointer:
        checkpointer.setup()

        if mode == "reset":
            checkpointer.delete_thread(THREAD_ID)
            print(f"已清理工作流：{THREAD_ID}")
            return

        graph = create_partial_generation_workflow(checkpointer=checkpointer)

        if mode == "start":
            start_workflow(graph, config)
            return

        if mode == "status":
            print_status(graph.get_state(config))
            return

        if mode == "continue":
            continue_workflow(graph, config)
            return

        if mode == "revise-page":
            revise_single_page(graph, config)
            return

        if mode == "outline-v2":
            publish_outline_v2(graph, config)
            return

        export_presentation(graph, config)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"执行失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
