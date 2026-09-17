"""持久化人工审核案例的命令行入口。"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

from langgraph.checkpoint.postgres import PostgresSaver

from workflow import (
    Command,
    create_review_workflow,
    get_pending_review,
    validate_review_submission,
)


SUPPORTED_MODES = {
    "reset",
    "start",
    "status",
    "approve",
    "revise",
    "reject",
    "approve-stale",
}
THREAD_ID = "presentation-review-1001"


def get_postgres_uri() -> str:
    """获取课程案例使用的 PostgreSQL 连接地址。"""

    return os.getenv(
        "POSTGRES_URI",
        "postgresql://agent_course:agent_course@localhost:5434/agent_review",
    )


def create_config() -> dict[str, Any]:
    """返回本案例固定使用的 Thread Config。"""

    return {
        "configurable": {
            "thread_id": THREAD_ID,
        },
    }


def print_status(snapshot: Any) -> None:
    """打印当前工作流以及待审核内容。"""

    values = getattr(snapshot, "values", {})
    pending_review = get_pending_review(snapshot)

    print(
        json.dumps(
            {
                "presentationId": values.get("presentationId"),
                "outline": values.get("outline"),
                "reviewStatus": values.get("reviewStatus"),
                "pageProductionStarted": values.get(
                    "pageProductionStarted",
                    False,
                ),
                "next": list(getattr(snapshot, "next", [])),
                "pendingReview": pending_review,
                "executionPath": values.get("executionPath", []),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def start_workflow(graph: Any, config: dict[str, Any]) -> None:
    """第一次启动工作流，运行到人工审核位置。"""

    print("========== 启动演示文稿制作流程 ==========")
    graph.invoke(
        {
            "presentationId": "PRESENTATION-1001",
        },
        config,
    )

    print("\n工作流已经暂停，等待用户审核。")
    print_status(graph.get_state(config))


def show_status(graph: Any, config: dict[str, Any]) -> None:
    """读取 Checkpoint，只查看当前审核状态。"""

    print("========== 读取待审核任务 ==========")
    snapshot = graph.get_state(config)

    if not getattr(snapshot, "values", {}).get("presentationId"):
        print("没有找到审核任务，请先执行 uv run python review_workflow.py start。")
        return

    print_status(snapshot)


def create_submission(
    *,
    mode: str,
    action: str,
    pending_review: dict[str, Any],
) -> dict[str, Any]:
    """创建批准、修改或者拒绝所需的审核提交。"""

    if mode == "approve-stale":
        return {
            "presentationId": pending_review["presentationId"],
            "outlineVersion": pending_review["outlineVersion"] - 1,
            "action": "approve",
            "feedback": None,
        }

    return {
        "presentationId": pending_review["presentationId"],
        "outlineVersion": pending_review["outlineVersion"],
        "action": action,
        "feedback": "增加一页企业 Agent 落地风险与控制方案。"
        if action == "revise"
        else None,
    }


def submit_review(graph: Any, config: dict[str, Any], mode: str, action: str) -> None:
    """校验审核请求，并通过 Command 恢复原来的工作流。"""

    # 读取当前 Thread 保存的最新工作流状态。
    snapshot = graph.get_state(config)

    # 从 State 中找到之前由 interrupt() 产生的待审核请求。
    pending_review = get_pending_review(snapshot)

    # 如果没有待处理的 interrupt，说明当前工作流并没有停在审核节点。
    if not pending_review:
        raise RuntimeError("没有找到待处理的审核请求，请先执行 uv run python review_workflow.py start。")

    # 根据用户选择的 action 和当前待审核信息，构造本次提交数据。
    submission = create_submission(
        mode=mode,
        action=action,
        pending_review=pending_review,
    )

    # 校验提交内容是否合法，例如审核版本是否仍然与当前大纲版本一致。
    decision = validate_review_submission(snapshot, submission)

    print("========== 提交审核决定 ==========")
    print(json.dumps(submission, ensure_ascii=False, indent=2))

    # 通过 Command(resume=...) 把审核结果传回之前的 interrupt()。
    # 工作流会从暂停的位置继续执行，而不是重新从头开始。
    graph.invoke(Command(resume=decision), config)

    print("\n审核处理完成后的最新状态：")
    print_status(graph.get_state(config))


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else None

    if mode not in SUPPORTED_MODES:
        raise ValueError(
            "请通过 uv run python review_workflow.py reset、start、status、approve、revise 或 reject 运行案例。"
        )

    config = create_config()

    # PostgresSaver 会把每一步 State 写入 PostgreSQL。
    # 因此 start、status、approve 等命令可以在不同进程中连续执行。
    with PostgresSaver.from_conn_string(get_postgres_uri()) as checkpointer:
        checkpointer.setup()

        if mode == "reset":
            checkpointer.delete_thread(THREAD_ID)
            print(f"已清理工作流：{THREAD_ID}")
            return

        graph = create_review_workflow(checkpointer=checkpointer)

        if mode == "start":
            start_workflow(graph, config)
            return

        if mode == "status":
            show_status(graph, config)
            return

        action = "approve" if mode == "approve-stale" else mode
        submit_review(graph, config, mode, action)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"审核失败：{error}", file=sys.stderr)
        raise SystemExit(1) from error
