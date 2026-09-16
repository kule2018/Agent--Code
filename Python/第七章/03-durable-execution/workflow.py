"""可持久化恢复的演示文稿制作流程。

本节关注 Durable Execution：

1. 工作流执行到一半发生异常；
2. 已完成节点的 State 被 Checkpointer 保存；
3. 新进程使用相同 thread_id 读取 checkpoint；
4. 恢复时只继续未完成的节点，而不是从头重跑。
"""

from __future__ import annotations

from typing import Annotated, Any, Callable, TypedDict

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel


class Requirements(BaseModel):
    topic: str
    audience: str
    pageCount: int


class Outline(BaseModel):
    title: str
    sections: list[str]


def append_execution_path(
    current: list[str] | None,
    node_name: str | list[str] | None,
) -> list[str]:
    """把每个 Node 写入的节点名称追加到执行路径。

    Node 版使用 ReducedValue 保存 executionPath。
    Python LangGraph 通过 Annotated reducer 表达同样的语义：
    Node 只返回当前节点名，reducer 负责把它追加到数组里。
    """

    current_path = current or []

    if node_name is None:
        return current_path

    if isinstance(node_name, list):
        return [*current_path, *node_name]

    return [*current_path, node_name]


class PresentationWorkflowState(TypedDict, total=False):
    """演示文稿制作流程中需要持续保存的运行状态。"""

    presentationId: str
    requirements: dict[str, Any] | None
    outline: dict[str, Any] | None
    draftSaved: bool
    executionPath: Annotated[list[str], append_execution_path]


def prepare_requirements(
    _state: PresentationWorkflowState,
) -> dict[str, Any]:
    """整理用户提交的演示文稿制作要求。"""

    print("[Node:prepare_requirements] 整理制作要求")

    return {
        "requirements": Requirements(
            topic="Agent 大模型课程发布方案",
            audience="企业技术负责人",
            pageCount=3,
        ).model_dump(),
        "executionPath": "prepare_requirements",
    }


def generate_outline(state: PresentationWorkflowState) -> dict[str, Any]:
    """模拟一次模型调用，根据制作要求生成大纲。"""

    print("[Node:generate_outline] 生成演示文稿大纲")

    requirements = state.get("requirements")

    if not requirements:
        raise RuntimeError("缺少演示文稿制作要求。")

    return {
        "outline": Outline(
            title=requirements["topic"],
            sections=["业务需求", "课程方案", "合作与交付"],
        ).model_dump(),
        "executionPath": "generate_outline",
    }


def create_presentation_workflow(
    *,
    checkpointer: Any,
    should_fail_save: Callable[[], bool],
):
    """创建可持久化的演示文稿制作流程。

    should_fail_save 只用于课程实验，
    用来模拟保存草稿时外部服务异常。
    """

    def save_outline_draft(
        _state: PresentationWorkflowState,
    ) -> dict[str, Any]:
        """保存大纲草稿。"""

        print("[Node:save_outline_draft] 保存大纲草稿")

        if should_fail_save():
            raise RuntimeError("模拟故障：大纲存储服务暂时不可用。")

        return {
            "draftSaved": True,
            "executionPath": "save_outline_draft",
        }

    graph_builder = StateGraph(PresentationWorkflowState)

    (
        graph_builder
        .add_node("prepare_requirements", prepare_requirements)
        .add_node("generate_outline", generate_outline)
        .add_node("save_outline_draft", save_outline_draft)
        .add_edge(START, "prepare_requirements")
        .add_edge("prepare_requirements", "generate_outline")
        .add_edge("generate_outline", "save_outline_draft")
        .add_edge("save_outline_draft", END)
    )

    return graph_builder.compile(checkpointer=checkpointer)
