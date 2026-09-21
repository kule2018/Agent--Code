"""把领域状态、模型能力和 Checkpoint 连接成可恢复的 LangGraph 工作流。"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from presentation_aggregate import PresentationAggregate
from presentation_exporter import PresentationExporter
from presentation_model import PresentationModelService, editable_requirements
from presentation_repository import PresentationRepository
from presentation_types import EditableRequirements, ReviewOutlineInput


Operation = Literal[
    "create",
    "revise_requirements",
    "continue_pages",
    "revise_page",
    "export",
]


class WorkflowState(TypedDict, total=False):
    """Checkpoint 保存的轻量工作流状态；完整业务对象留在 Repository。"""

    presentationId: str
    operation: Operation
    queue: list[str]
    currentPageId: str | None
    targetPageId: str | None
    changeRequest: str | None
    nextRequirements: dict[str, Any] | None
    reviewDecision: Literal["approve", "revise", "reject"] | None
    reviewFeedback: str | None
    executionPath: list[str]


class PresentationGraphService:
    """对外提供启动、审核恢复、续做、单页重做与导出等工作流操作。"""

    def __init__(
        self,
        repository: PresentationRepository,
        models: PresentationModelService,
        exporter: PresentationExporter,
        checkpointer: Any,
    ) -> None:
        self.repository = repository
        self.models = models
        self.exporter = exporter
        self.graph = self._create_graph(checkpointer)

    def start(self, presentation_id: str) -> None:
        """生成第一版大纲，并在人工审核节点暂停。"""

        self.graph.invoke(
            {"presentationId": presentation_id, "operation": "create"},
            self._config(presentation_id),
        )

    def review(self, presentation_id: str, decision: ReviewOutlineInput) -> None:
        """校验审核版本后通过 Command(resume=...) 从 interrupt 处恢复。"""

        config = self._config(presentation_id)
        snapshot = self.graph.get_state(config)
        pending = self._find_pending_review(snapshot)
        if pending is None:
            raise ValueError("当前任务没有等待处理的大纲审核。")
        if pending["outlineVersion"] != decision.outlineVersion:
            raise ValueError(
                f"审核版本已经过期：当前等待审核的是 Outline v{pending['outlineVersion']}。"
            )
        self.graph.invoke(Command(resume=decision.model_dump()), config)

    def continue_pages(self, presentation_id: str) -> None:
        """仅让 pending、failed 或 stale 的页面重新进入队列。"""

        self._invoke_operation(presentation_id, "continue_pages")

    def revise_page(self, presentation_id: str, page_id: str, change_request: str) -> None:
        """只为指定页面创建新 Revision，并重新生成该页。"""

        self._invoke_operation(
            presentation_id,
            "revise_page",
            targetPageId=page_id,
            changeRequest=change_request,
        )

    def revise_requirements(
        self,
        presentation_id: str,
        next_requirements: EditableRequirements,
        instruction: str,
    ) -> None:
        """全局内容调整会生成新大纲，并重新等待人工审核。"""

        self._invoke_operation(
            presentation_id,
            "revise_requirements",
            nextRequirements=next_requirements.model_dump(),
            changeRequest=instruction,
        )

    def export(self, presentation_id: str) -> None:
        self._invoke_operation(presentation_id, "export")

    def _create_graph(self, checkpointer: Any) -> Any:
        return (
            StateGraph(WorkflowState)
            .add_node("route_operation", self._route_operation)
            .add_node("generate_outline", self._generate_outline)
            .add_node("review_outline", self._review_outline)
            .add_node("revise_outline", self._revise_outline)
            .add_node("prepare_pages", self._prepare_pages)
            .add_node("prepare_continue", self._prepare_continue)
            .add_node("prepare_page_revision", self._prepare_page_revision)
            .add_node("select_page", self._select_page)
            .add_node("generate_page", self._generate_page)
            .add_node("summarize_pages", self._summarize_pages)
            .add_node("export_presentation", self._export_presentation)
            .add_node("finish_rejected", self._finish_rejected)
            .add_edge(START, "route_operation")
            .add_conditional_edges(
                "route_operation",
                self._route_after_operation,
                {
                    "generate_outline": "generate_outline",
                    "revise_outline": "revise_outline",
                    "prepare_continue": "prepare_continue",
                    "prepare_page_revision": "prepare_page_revision",
                    "export_presentation": "export_presentation",
                },
            )
            .add_edge("generate_outline", "review_outline")
            .add_conditional_edges(
                "review_outline",
                self._route_after_review,
                {
                    "prepare_pages": "prepare_pages",
                    "revise_outline": "revise_outline",
                    "finish_rejected": "finish_rejected",
                },
            )
            .add_edge("revise_outline", "review_outline")
            .add_conditional_edges(
                "prepare_pages",
                self._route_after_queue_prepared,
                {"select_page": "select_page", "summarize_pages": "summarize_pages"},
            )
            .add_conditional_edges(
                "prepare_continue",
                self._route_after_queue_prepared,
                {"select_page": "select_page", "summarize_pages": "summarize_pages"},
            )
            .add_edge("prepare_page_revision", "select_page")
            .add_edge("select_page", "generate_page")
            .add_conditional_edges(
                "generate_page",
                self._route_after_page,
                {"select_page": "select_page", "summarize_pages": "summarize_pages"},
            )
            .add_edge("summarize_pages", END)
            .add_edge("export_presentation", END)
            .add_edge("finish_rejected", END)
            .compile(checkpointer=checkpointer)
        )

    @staticmethod
    def _path(state: WorkflowState, step: str) -> list[str]:
        return [*state.get("executionPath", []), step]

    def _route_operation(self, state: WorkflowState) -> dict[str, Any]:
        operation = state.get("operation", "create")
        return {"executionPath": self._path(state, f"operation:{operation}")}

    @staticmethod
    def _route_after_operation(state: WorkflowState) -> str:
        targets = {
            "create": "generate_outline",
            "revise_requirements": "revise_outline",
            "continue_pages": "prepare_continue",
            "revise_page": "prepare_page_revision",
            "export": "export_presentation",
        }
        return targets[state.get("operation", "create")]

    def _generate_outline(self, state: WorkflowState) -> dict[str, Any]:
        """首次生成大纲后立即进入审核节点，而不是直接制作页面。"""

        aggregate = self._load(state["presentationId"])
        presentation = aggregate.to_model()
        provider = self.models.get_provider(presentation.modelMode)
        draft = provider.generate_outline(
            presentation.requirements,
            (presentation.currentOutlineVersion or 0) + 1,
            aggregate.current_outline,
            state.get("reviewFeedback"),
        )
        aggregate.add_outline(draft, state.get("reviewFeedback"))
        self.repository.save(aggregate.to_model())
        return {
            "reviewDecision": None,
            "reviewFeedback": None,
            "executionPath": self._path(state, "generate_outline"),
        }

    def _review_outline(self, state: WorkflowState) -> dict[str, Any]:
        """interrupt 会持久化暂停点；API 审核接口可在另一请求中恢复它。"""

        before_interrupt = self._load(state["presentationId"])
        outline = before_interrupt.current_outline
        if outline is None:
            raise ValueError("没有找到待审核大纲。")

        decision = ReviewOutlineInput.model_validate(
            interrupt(
                {
                    "type": "outline_review",
                    "presentationId": state["presentationId"],
                    "outlineVersion": outline.version,
                    "allowedActions": ["approve", "revise", "reject"],
                }
            )
        )
        if decision.decision == "revise" and not decision.feedback:
            raise ValueError("要求修改大纲时，必须填写具体修改意见。")

        # 恢复后重新加载，避免拿着 interrupt 前的旧聚合继续修改。
        aggregate = self._load(state["presentationId"])
        aggregate.assert_reviewable(decision.outlineVersion)
        next_requirements: EditableRequirements | None = None
        if decision.decision == "revise":
            plan = self.models.get_provider(aggregate.to_model().modelMode).plan_change(
                decision.feedback,
                aggregate.to_model(),
            )
            if plan.scope == "global_content":
                if plan.nextRequirements is None:
                    raise ValueError("大纲修改计划缺少新的全局制作要求。")
                next_requirements = plan.nextRequirements
        if decision.decision == "approve":
            aggregate.approve_outline(decision.outlineVersion)
            self.repository.save(aggregate.to_model())
        elif decision.decision == "reject":
            aggregate.reject_outline(decision.outlineVersion, decision.feedback)
            self.repository.save(aggregate.to_model())

        return {
            "reviewDecision": decision.decision,
            "reviewFeedback": decision.feedback,
            "nextRequirements": next_requirements.model_dump() if next_requirements else None,
            "executionPath": self._path(state, f"review:{decision.decision}"),
        }

    @staticmethod
    def _route_after_review(state: WorkflowState) -> str:
        if state.get("reviewDecision") == "approve":
            return "prepare_pages"
        if state.get("reviewDecision") == "revise":
            return "revise_outline"
        return "finish_rejected"

    def _revise_outline(self, state: WorkflowState) -> dict[str, Any]:
        """把审核反馈或全局变更转成新版大纲；旧页面由聚合统一标为 stale。"""

        aggregate = self._load(state["presentationId"])
        presentation = aggregate.to_model()
        previous_outline = aggregate.current_outline
        if previous_outline is None:
            raise ValueError("没有找到需要修改的大纲。")
        feedback = state.get("changeRequest") or state.get("reviewFeedback")
        raw_next = state.get("nextRequirements")
        next_requirements = EditableRequirements.model_validate(raw_next) if raw_next else None
        requirements = (
            presentation.requirements.model_copy(update=next_requirements.model_dump())
            if next_requirements is not None
            else presentation.requirements
        )
        provider = self.models.get_provider(presentation.modelMode)
        draft = provider.generate_outline(
            requirements,
            previous_outline.version + 1,
            previous_outline,
            feedback,
        )
        if next_requirements is not None:
            aggregate.update_requirements(next_requirements, feedback or "更新制作要求")
        aggregate.add_outline(draft, feedback)
        self.repository.save(aggregate.to_model())
        return {
            "reviewDecision": None,
            "reviewFeedback": None,
            "changeRequest": None,
            "nextRequirements": None,
            "executionPath": self._path(state, "revise_outline"),
        }

    def _prepare_pages(self, state: WorkflowState) -> dict[str, Any]:
        aggregate = self._load(state["presentationId"])
        aggregate.ensure_page_tasks()
        self.repository.save(aggregate.to_model())
        return {
            "queue": aggregate.get_pending_page_ids(),
            "currentPageId": None,
            "executionPath": self._path(state, "prepare_pages"),
        }

    def _prepare_continue(self, state: WorkflowState) -> dict[str, Any]:
        aggregate = self._load(state["presentationId"])
        return {
            "queue": aggregate.get_pending_page_ids(),
            "currentPageId": None,
            "executionPath": self._path(state, "prepare_continue"),
        }

    def _prepare_page_revision(self, state: WorkflowState) -> dict[str, Any]:
        if not state.get("targetPageId") or not state.get("changeRequest"):
            raise ValueError("单页修改缺少 pageId 或修改要求。")
        aggregate = self._load(state["presentationId"])
        aggregate.request_page_revision(state["targetPageId"], state["changeRequest"])
        self.repository.save(aggregate.to_model())
        return {
            "queue": [state["targetPageId"]],
            "currentPageId": None,
            "executionPath": self._path(state, "prepare_page_revision"),
        }

    @staticmethod
    def _route_after_queue_prepared(state: WorkflowState) -> str:
        return "select_page" if state.get("queue", []) else "summarize_pages"

    def _select_page(self, state: WorkflowState) -> dict[str, Any]:
        queue = state.get("queue", [])
        if not queue:
            raise ValueError("页面执行队列为空。")
        current_page_id, *remaining = queue
        return {
            "currentPageId": current_page_id,
            "queue": remaining,
            "executionPath": self._path(state, f"select:{current_page_id}"),
        }

    def _generate_page(self, state: WorkflowState) -> dict[str, Any]:
        """单页失败只记录本页错误，其余页面继续执行并保留成功结果。"""

        page_id = state.get("currentPageId")
        if page_id is None:
            raise ValueError("没有指定当前页面。")
        aggregate = self._load(state["presentationId"])
        presentation = aggregate.to_model()
        provider = self.models.get_provider(presentation.modelMode)
        page = aggregate.start_page(page_id)
        self.repository.save(aggregate.to_model())

        try:
            # Replay 第一次制作第三页时注入失败，便于演示部分成功与续做。
            if (
                provider.mode == "replay"
                and page.order == 3
                and page.pageRevision == 1
                and page.attempts == 1
            ):
                raise RuntimeError("页面生成服务暂时不可用")
            latest = self._load(state["presentationId"])
            outline = latest.current_outline
            if outline is None:
                raise ValueError("没有找到当前大纲。")
            content = provider.generate_page(
                latest.to_model().requirements,
                outline,
                latest.get_page(page_id),
            )
            latest.complete_page(page_id, content)
            self.repository.save(latest.to_model())
        except Exception as error:
            failed = self._load(state["presentationId"])
            failed.fail_page(page_id, str(error) or "页面生成失败")
            self.repository.save(failed.to_model())

        return {"executionPath": self._path(state, f"generate:{page_id}")}

    @staticmethod
    def _route_after_page(state: WorkflowState) -> str:
        return "select_page" if state.get("queue", []) else "summarize_pages"

    def _summarize_pages(self, state: WorkflowState) -> dict[str, Any]:
        return {
            "currentPageId": None,
            "executionPath": self._path(state, "summarize_pages"),
        }

    def _export_presentation(self, state: WorkflowState) -> dict[str, Any]:
        aggregate = self._load(state["presentationId"])
        pages = aggregate.assert_exportable()
        outline = aggregate.current_outline
        if outline is None:
            raise ValueError("没有找到当前大纲。")
        record = self.exporter.export(aggregate.to_model(), outline, pages)
        aggregate.record_export(record)
        self.repository.save(aggregate.to_model())
        return {"executionPath": self._path(state, "export_presentation")}

    def _finish_rejected(self, state: WorkflowState) -> dict[str, Any]:
        return {"executionPath": self._path(state, "finish_rejected")}

    def _invoke_operation(
        self,
        presentation_id: str,
        operation: Operation,
        **extra: Any,
    ) -> None:
        config = self._config(presentation_id)
        snapshot = self.graph.get_state(config)
        values = getattr(snapshot, "values", {})
        if not values.get("presentationId"):
            raise ValueError("没有找到该任务的工作流状态。")
        self.graph.invoke(
            {
                **values,
                "operation": operation,
                "queue": [],
                "currentPageId": None,
                "targetPageId": None,
                "changeRequest": None,
                "nextRequirements": None,
                "reviewDecision": None,
                "reviewFeedback": None,
                **extra,
            },
            config,
        )

    def _load(self, presentation_id: str) -> PresentationAggregate:
        value = self.repository.find_by_id(presentation_id)
        if value is None:
            raise ValueError(f"没有找到演示文稿任务：{presentation_id}")
        return PresentationAggregate.restore(value)

    @staticmethod
    def _config(presentation_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": f"presentation:{presentation_id}"}}

    @staticmethod
    def _find_pending_review(snapshot: Any) -> dict[str, Any] | None:
        for task in getattr(snapshot, "tasks", []):
            interrupts = getattr(task, "interrupts", None)
            if interrupts is None and isinstance(task, dict):
                interrupts = task.get("interrupts")
            for pending in interrupts or []:
                value = pending.get("value") if isinstance(pending, dict) else getattr(pending, "value", None)
                if isinstance(value, dict) and value.get("type") == "outline_review":
                    return value
        return None
