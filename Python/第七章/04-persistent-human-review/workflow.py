"""带持久化人工审核能力的演示文稿制作流程。

本节关注 Human-in-the-loop：

1. 工作流生成待审核的大纲；
2. interrupt() 暂停 Graph，把审核任务交给外部用户；
3. 用户提交 approve、revise 或 reject；
4. 工作流从暂停位置继续，而不是重新开始执行。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt
from pydantic import BaseModel, Field


ReviewAction = Literal["approve", "revise", "reject"]
ReviewStatus = Literal["not_started", "pending", "approved", "rejected"]


class Requirements(BaseModel):
    topic: str
    audience: str
    pageCount: int


class Outline(BaseModel):
    version: int
    title: str
    sections: list[str]


class ReviewDecision(BaseModel):
    action: ReviewAction
    outlineVersion: int
    feedback: str | None = None


class ReviewSubmission(BaseModel):
    presentationId: str
    outlineVersion: int
    action: ReviewAction
    feedback: str | None = Field(default=None)


def append_execution_path(
    current: list[str] | None,
    node_name: str | list[str] | None,
) -> list[str]:
    """把每个 Node 写入的节点名称追加到执行路径。"""

    current_path = current or []

    if node_name is None:
        return current_path

    if isinstance(node_name, list):
        return [*current_path, *node_name]

    return [*current_path, node_name]


class ReviewWorkflowState(TypedDict, total=False):
    """大纲生成、人工审核和后续制作共同使用的工作流状态。"""

    presentationId: str
    requirements: dict[str, Any] | None
    outline: dict[str, Any] | None
    reviewStatus: ReviewStatus
    reviewDecision: ReviewAction | None
    reviewFeedback: str | None
    pageProductionStarted: bool
    executionPath: Annotated[list[str], append_execution_path]


def prepare_requirements(
    _state: ReviewWorkflowState,
) -> dict[str, Any]:
    """整理本次演示文稿的制作要求。"""

    print("[Node:prepare_requirements] 整理制作要求")

    return {
        "requirements": Requirements(
            topic="Agent 大模型课程发布方案",
            audience="企业技术负责人",
            pageCount=3,
        ).model_dump(),
        "executionPath": "prepare_requirements",
    }


def generate_outline(state: ReviewWorkflowState) -> dict[str, Any]:
    """生成第一版待审核大纲。"""

    print("[Node:generate_outline] 生成 Outline v1")

    requirements = state.get("requirements")

    if not requirements:
        raise RuntimeError("缺少演示文稿制作要求。")

    return {
        "outline": Outline(
            version=1,
            title=requirements["topic"],
            sections=["业务需求", "课程方案", "合作与交付"],
        ).model_dump(),
        "reviewStatus": "pending",
        "executionPath": "generate_outline",
    }


def review_outline(state: ReviewWorkflowState) -> dict[str, Any]:
    """暂停工作流，把当前大纲交给用户审核。"""

    outline = state.get("outline")

    if not outline:
        raise RuntimeError("缺少待审核的大纲。")

    # 记录当前进入审核的大纲版本，方便观察工作流执行过程。
    print(f"[Node:review_outline] 等待审核 Outline v{outline['version']}")

    # interrupt 会暂停当前 Graph，并把大纲及允许操作返回给外部应用。
    # 用户完成审核后，Graph 从这里恢复，interrupt 会返回用户提交的结果。
    decision = ReviewDecision.model_validate(
        interrupt(
            {
                "type": "outline_review",
                "presentationId": state["presentationId"],
                "outlineVersion": outline["version"],
                "outline": outline,
                # 用户只能从批准、修改和拒绝三个动作中选择。
                "allowedActions": ["approve", "revise", "reject"],
            }
        )
    )

    # 保存本次审核结果，供后续节点决定工作流应该走哪条分支。
    return {
        "reviewDecision": decision.action,
        "reviewFeedback": decision.feedback,
        "executionPath": f"review_{decision.action}",
    }


def route_after_review(state: ReviewWorkflowState) -> ReviewAction:
    """根据用户提交的审核决定选择后续 Node。"""

    decision = state.get("reviewDecision")

    if decision not in ("approve", "revise", "reject"):
        raise RuntimeError("缺少有效的审核决定。")

    return decision


def start_page_production(
    _state: ReviewWorkflowState,
) -> dict[str, Any]:
    """审核通过后开始创建页面制作任务。"""

    print("[Node:start_page_production] 大纲已批准，开始页面制作")

    return {
        "reviewStatus": "approved",
        "pageProductionStarted": True,
        "executionPath": "start_page_production",
    }


def revise_outline(state: ReviewWorkflowState) -> dict[str, Any]:
    """根据修改意见生成新版大纲，并再次进入人工审核。"""

    outline = state.get("outline")

    if not outline:
        raise RuntimeError("缺少可修改的大纲。")

    next_version = int(outline["version"]) + 1
    print(f"[Node:revise_outline] 生成 Outline v{next_version}")

    return {
        "outline": Outline(
            version=next_version,
            title=outline["title"],
            sections=[
                *outline["sections"][:-1],
                f"修改说明：{state.get('reviewFeedback')}",
            ],
        ).model_dump(),
        "reviewStatus": "pending",
        "reviewDecision": None,
        "reviewFeedback": None,
        "executionPath": "revise_outline",
    }


def reject_presentation(
    _state: ReviewWorkflowState,
) -> dict[str, Any]:
    """用户拒绝后结束当前制作任务。"""

    print("[Node:reject_presentation] 用户拒绝大纲，结束制作任务")

    return {
        "reviewStatus": "rejected",
        "executionPath": "reject_presentation",
    }


def _get_interrupt_value(pending_interrupt: Any) -> Any:
    """兼容不同版本 LangGraph 中 interrupt 的对象形态。"""

    if isinstance(pending_interrupt, dict):
        return pending_interrupt.get("value")

    return getattr(pending_interrupt, "value", None)


def get_pending_review(snapshot: Any) -> dict[str, Any] | None:
    """从 StateSnapshot 中读取当前等待处理的审核请求。"""

    for task in getattr(snapshot, "tasks", []):
        interrupts = getattr(task, "interrupts", None)

        if interrupts is None and isinstance(task, dict):
            interrupts = task.get("interrupts")

        for pending_interrupt in interrupts or []:
            value = _get_interrupt_value(pending_interrupt)

            if isinstance(value, dict) and value.get("type") == "outline_review":
                return value

    return None


def validate_review_submission(
    snapshot: Any,
    submission: dict[str, Any],
) -> dict[str, Any]:
    """在恢复 Graph 前校验当前提交是否仍对应待审核版本。"""

    pending_review = get_pending_review(snapshot)
    values = getattr(snapshot, "values", {})

    if not pending_review or values.get("reviewStatus") != "pending":
        raise ValueError("当前任务没有等待处理的大纲审核。")

    parsed_submission = ReviewSubmission.model_validate(submission)

    if parsed_submission.presentationId != pending_review["presentationId"]:
        raise ValueError("当前审核请求不属于这项演示文稿制作任务。")

    if parsed_submission.outlineVersion != pending_review["outlineVersion"]:
        raise ValueError(
            f"审核版本已经过期：当前版本为 v{pending_review['outlineVersion']}。"
        )

    if parsed_submission.action == "revise" and not (
        parsed_submission.feedback or ""
    ).strip():
        raise ValueError("请求修改大纲时必须提供修改意见。")

    return {
        "action": parsed_submission.action,
        "outlineVersion": parsed_submission.outlineVersion,
        "feedback": parsed_submission.feedback,
    }


def create_review_workflow(*, checkpointer: Any):
    """创建带有持久化人工审核能力的演示文稿制作流程。"""

    graph_builder = StateGraph(ReviewWorkflowState)

    (
        graph_builder
        .add_node("prepare_requirements", prepare_requirements)
        .add_node("generate_outline", generate_outline)
        .add_node("review_outline", review_outline)
        .add_node("start_page_production", start_page_production)
        .add_node("revise_outline", revise_outline)
        .add_node("reject_presentation", reject_presentation)
        .add_edge(START, "prepare_requirements")
        .add_edge("prepare_requirements", "generate_outline")
        .add_edge("generate_outline", "review_outline")
        .add_conditional_edges(
            "review_outline",
            route_after_review,
            {
                "approve": "start_page_production",
                "revise": "revise_outline",
                "reject": "reject_presentation",
            },
        )
        .add_edge("start_page_production", END)
        .add_edge("revise_outline", "review_outline")
        .add_edge("reject_presentation", END)
    )

    return graph_builder.compile(checkpointer=checkpointer)
