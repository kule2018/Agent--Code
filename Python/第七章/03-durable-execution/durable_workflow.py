"""Durable Execution 命令行演示入口。"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from workflow import create_presentation_workflow


SUPPORTED_MODES = {"reset", "start", "status", "resume"}
THREAD_ID = "presentation-workflow-1001"
DEFAULT_POSTGRES_URI = (
    "postgresql://agent_course:agent_course@localhost:5433/agent_workflow"
)


def get_postgres_uri() -> str:
    """获取课程案例使用的 PostgreSQL 连接地址。"""

    return os.getenv("POSTGRES_URI", DEFAULT_POSTGRES_URI)


def create_config() -> dict[str, Any]:
    """返回当前工作流固定使用的 Thread Config。"""

    return {
        "configurable": {
            "thread_id": THREAD_ID,
        }
    }


def task_to_dict(task: Any) -> dict[str, Any]:
    """兼容 LangGraph Python 中不同版本的 task 对象。"""

    return {
        "name": getattr(task, "name", None)
        if not isinstance(task, dict)
        else task.get("name"),
        "error": getattr(task, "error", None)
        if not isinstance(task, dict)
        else task.get("error"),
    }


def print_snapshot(snapshot: Any) -> None:
    """打印最新 Checkpoint 中最值得观察的三部分信息。"""

    values = snapshot.values or {}
    payload = {
        "values": {
            "presentationId": values.get("presentationId"),
            "requirements": values.get("requirements"),
            "outline": values.get("outline"),
            "draftSaved": values.get("draftSaved"),
            "executionPath": values.get("executionPath"),
        },
        "next": list(snapshot.next or []),
        "tasks": [task_to_dict(task) for task in snapshot.tasks],
    }

    print("\n最新 Checkpoint：")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def start_workflow(graph: Any, config: dict[str, Any]) -> None:
    """第一次运行流程，并在保存草稿节点模拟一次故障。"""

    print("========== 第一次进程：启动制作流程 ==========")

    try:
        graph.invoke(
            {
                "presentationId": "PRESENTATION-1001",
            },
            config,
        )
    except Exception as error:
        print(f"\n流程中断：{error}")
        print("当前 Python 进程即将结束。")


def show_workflow_status(graph: Any, config: dict[str, Any]) -> None:
    """读取数据库中保存的最新工作流状态，不执行任何 Node。"""

    print("========== 新进程：读取工作流进度 ==========")

    # 根据当前 thread_id 读取最近一次保存的工作流快照。
    # get_state() 只读取 Checkpoint，不会触发任何 Node 执行。
    snapshot = graph.get_state(config)

    # 如果没有 presentationId，说明当前 Thread 下还没有可恢复的工作流状态。
    if not (snapshot.values or {}).get("presentationId"):
        print("没有找到待恢复的工作流，请先执行 python durable_workflow.py start。")
        return

    # 打印当前保存的状态，用于查看工作流已经执行到哪里。
    print_snapshot(snapshot)


def resume_workflow(graph: Any, config: dict[str, Any]) -> None:
    """使用相同 thread_id，从最新 Checkpoint 继续未完成的 Node。"""

    print("========== 新进程：恢复制作流程 ==========")
    before_resume = graph.get_state(config)

    if not (before_resume.values or {}).get("presentationId"):
        print("没有找到待恢复的工作流，请先执行 python durable_workflow.py start。")
        return

    print(f"恢复前待执行 Node：{', '.join(before_resume.next or []) or '无'}")
    result = graph.invoke(None, config)

    print("\n流程恢复完成：")
    print(
        json.dumps(
            {
                "draftSaved": result.get("draftSaved"),
                "executionPath": result.get("executionPath"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main(argv: list[str] | None = None) -> None:
    """连接持久化存储，并根据命令执行一次独立的课程实验。"""

    argv = argv if argv is not None else sys.argv[1:]
    mode = argv[0] if argv else None

    if mode not in SUPPORTED_MODES:
        raise RuntimeError("请通过 reset、start、status 或 resume 运行案例。")

    try:
        from langgraph.checkpoint.postgres import PostgresSaver
    except ImportError as exc:
        raise RuntimeError(
            "缺少 langgraph-checkpoint-postgres 依赖，请先执行：python -m pip install -e ."
        ) from exc

    # 使用 PostgreSQL 创建 LangGraph Checkpointer，
    # 用于持久化工作流状态，使任务可以跨进程暂停和恢复。
    with PostgresSaver.from_conn_string(get_postgres_uri()) as checkpointer:
        # 初始化 Checkpointer 所需的数据库表。
        checkpointer.setup()

        # reset 模式：删除当前 Thread 保存的所有工作流状态。
        if mode == "reset":
            checkpointer.delete_thread(THREAD_ID)
            print(f"已清理工作流：{THREAD_ID}")
            return

        config = create_config()
        graph = create_presentation_workflow(
            checkpointer=checkpointer,
            should_fail_save=lambda: mode == "start",
        )

        if mode == "start":
            start_workflow(graph, config)
            return

        if mode == "status":
            show_workflow_status(graph, config)
            return

        resume_workflow(graph, config)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
