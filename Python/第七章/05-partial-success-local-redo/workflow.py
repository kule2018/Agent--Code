"""演示页面制作任务的部分成功、局部重做和版本校验。

本节的页面生成服务是确定性的模拟服务，便于观察以下状态变化：

1. 首次生成时，第三页故意失败，前两页产物仍会被保留；
2. 再次执行只补做失败、缺失或已失效的页面；
3. 修改单页时，不影响其他页面的现有产物；
4. 发布新版大纲后，旧版本页面不能和新版本页面一起导出。
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph


Operation = Literal[
    "initial",
    "continue",
    "revise_page",
    "publish_outline",
    "export",
]
PageStatus = Literal["pending", "completed", "failed", "stale"]


class PageTask(TypedDict):
    """每一页当前需要生成的版本和执行状态。"""

    pageId: str
    title: str
    outlineVersion: int
    pageRevision: int
    status: PageStatus
    attempts: int
    currentArtifactId: str | None
    lastError: str | None


class PageArtifact(TypedDict):
    """页面生成成功后保存的不可变产物。"""

    artifactId: str
    pageId: str
    title: str
    outlineVersion: int
    pageRevision: int
    content: str


class ExportResult(TypedDict):
    """导出前版本校验的结果。"""

    ok: bool
    reason: str
    artifactIds: list[str]


class PartialGenerationState(TypedDict, total=False):
    """保存页面任务、页面产物以及当前运行进度。"""

    presentationId: str
    operation: Operation
    targetPageId: str | None
    changeRequest: str | None
    outlineVersion: int
    outlineSections: list[str]
    pageTasks: list[PageTask]
    artifacts: list[PageArtifact]
    queue: list[str]
    currentPageId: str | None
    runStatus: Literal[
        "not_started",
        "running",
        "partially_completed",
        "waiting_generation",
        "completed",
        "export_blocked",
        "exported",
    ]
    exportResult: ExportResult | None
    executionPath: list[str]


INITIAL_SECTIONS = ["业务需求", "课程方案", "技术架构", "合作与交付"]


def create_page_tasks(sections: list[str], outline_version: int) -> list[PageTask]:
    """创建与当前大纲对应的页面任务。"""

    return [
        {
            "pageId": f"page-{index}",
            "title": title,
            "outlineVersion": outline_version,
            "pageRevision": 1,
            "status": "pending",
            "attempts": 0,
            "currentArtifactId": None,
            "lastError": None,
        }
        for index, title in enumerate(sections, start=1)
    ]


def _execution_path(state: PartialGenerationState, step: str) -> list[str]:
    """在更新中写回完整路径，方便命令行观察实际分支。"""

    return [*state.get("executionPath", []), step]


def prepare_run(state: PartialGenerationState) -> dict[str, Any]:
    """根据本次操作准备真正需要执行的页面队列。"""

    operation = state.get("operation", "initial")
    print(f"[Python:prepare_run] 准备操作：{operation}")

    if operation == "initial":
        if state.get("pageTasks", []):
            raise RuntimeError("当前任务已经初始化，请先执行 uv run python partial_generation.py reset。")

        outline_version = state.get("outlineVersion", 1)
        page_tasks = create_page_tasks(INITIAL_SECTIONS, outline_version)

        return {
            "operation": operation,
            "targetPageId": None,
            "changeRequest": None,
            "outlineVersion": outline_version,
            "outlineSections": INITIAL_SECTIONS,
            "pageTasks": page_tasks,
            "artifacts": state.get("artifacts", []),
            "queue": [task["pageId"] for task in page_tasks],
            "currentPageId": None,
            "runStatus": "running",
            "exportResult": None,
            "executionPath": _execution_path(state, "prepare_initial"),
        }

    if operation == "continue":
        page_tasks = state.get("pageTasks", [])
        target_ids = [
            task["pageId"]
            for task in page_tasks
            if task["status"] != "completed"
        ]
        outline_version = state.get("outlineVersion", 1)

        prepared_tasks: list[PageTask] = []
        for task in page_tasks:
            if task["pageId"] not in target_ids:
                prepared_tasks.append(task)
                continue

            version_changed = task["outlineVersion"] != outline_version
            prepared_tasks.append(
                {
                    **task,
                    "outlineVersion": outline_version,
                    "pageRevision": 1 if version_changed else task["pageRevision"],
                    "status": "pending",
                    "currentArtifactId": None,
                    "lastError": None,
                }
            )

        return {
            "pageTasks": prepared_tasks,
            "queue": target_ids,
            "runStatus": "running" if target_ids else "completed",
            "exportResult": None,
            "executionPath": _execution_path(state, "prepare_continue"),
        }

    if operation == "revise_page":
        target_page_id = state.get("targetPageId")
        page_tasks = state.get("pageTasks", [])
        target = next(
            (task for task in page_tasks if task["pageId"] == target_page_id),
            None,
        )

        if target is None:
            raise RuntimeError(f"没有找到页面任务：{target_page_id}")

        prepared_tasks: list[PageTask] = []
        for task in page_tasks:
            if task["pageId"] != target_page_id:
                prepared_tasks.append(task)
                continue

            prepared_tasks.append(
                {
                    **task,
                    "pageRevision": task["pageRevision"] + 1,
                    "status": "pending",
                    "currentArtifactId": None,
                    "lastError": None,
                }
            )

        return {
            "pageTasks": prepared_tasks,
            "queue": [target_page_id],
            "runStatus": "running",
            "exportResult": None,
            "executionPath": _execution_path(
                state,
                f"prepare_revise:{target_page_id}",
            ),
        }

    if operation == "publish_outline":
        next_outline_version = state.get("outlineVersion", 1) + 1
        outline_sections = [
            "核心能力与落地方案" if index == 1 else title
            for index, title in enumerate(state.get("outlineSections", []))
        ]

        stale_tasks: list[PageTask] = []
        for index, task in enumerate(state.get("pageTasks", [])):
            stale_tasks.append(
                {
                    **task,
                    "title": outline_sections[index],
                    "status": "stale",
                    "lastError": f"当前产物属于 Outline v{task['outlineVersion']}",
                }
            )

        return {
            "outlineVersion": next_outline_version,
            "outlineSections": outline_sections,
            "pageTasks": stale_tasks,
            "queue": [],
            "runStatus": "waiting_generation",
            "exportResult": None,
            "executionPath": _execution_path(
                state,
                f"publish_outline:v{next_outline_version}",
            ),
        }

    return {
        "queue": [],
        "executionPath": _execution_path(state, "prepare_export"),
    }


def route_after_prepare(state: PartialGenerationState) -> str:
    """决定准备完成后进入页面生成、导出校验还是直接收尾。"""

    if state.get("operation") == "export":
        return "validate_export"

    return "select_page" if state.get("queue", []) else "summarize_run"


def select_page(state: PartialGenerationState) -> dict[str, Any]:
    """从待处理队列中取出下一页。"""

    queue = state.get("queue", [])
    current_page_id, *remaining_queue = queue

    return {
        "currentPageId": current_page_id,
        "queue": remaining_queue,
        "executionPath": _execution_path(state, f"select:{current_page_id}"),
    }


def create_artifact_id(presentation_id: str, task: PageTask) -> str:
    """为页面和版本生成稳定的产物 ID，真实项目中可作为幂等键。"""

    return ":".join(
        [
            presentation_id,
            f"outline-v{task['outlineVersion']}",
            task["pageId"],
            f"revision-{task['pageRevision']}",
        ]
    )


def generate_page(state: PartialGenerationState) -> dict[str, Any]:
    """模拟页面生成服务，并把成功或失败结果写回页面任务。"""

    current_page_id = state.get("currentPageId")
    task = next(
        (
            item
            for item in state.get("pageTasks", [])
            if item["pageId"] == current_page_id
        ),
        None,
    )

    if task is None:
        raise RuntimeError(f"没有找到当前页面：{current_page_id}")

    attempts = task["attempts"] + 1
    print(
        "[Python:generate_page] "
        f"{task['pageId']} / Outline v{task['outlineVersion']} / "
        f"页面 r{task['pageRevision']}"
    )

    # 第一次制作 Outline v1 的第三页时返回失败，用来观察部分成功。
    if (
        task["pageId"] == "page-3"
        and task["outlineVersion"] == 1
        and task["pageRevision"] == 1
        and attempts == 1
    ):
        print("  -> 页面生成服务暂时不可用，本页标记为 failed")

        return {
            "pageTasks": [
                {
                    **item,
                    "attempts": attempts,
                    "status": "failed",
                    "lastError": "页面生成服务暂时不可用",
                }
                if item["pageId"] == task["pageId"]
                else item
                for item in state.get("pageTasks", [])
            ],
            "executionPath": _execution_path(state, f"failed:{task['pageId']}"),
        }

    artifact_id = create_artifact_id(state["presentationId"], task)
    artifacts = state.get("artifacts", [])
    existing_artifact = next(
        (
            artifact
            for artifact in artifacts
            if artifact["artifactId"] == artifact_id
        ),
        None,
    )
    artifact: PageArtifact = existing_artifact or {
        "artifactId": artifact_id,
        "pageId": task["pageId"],
        "title": task["title"],
        "outlineVersion": task["outlineVersion"],
        "pageRevision": task["pageRevision"],
        "content": (
            f"{task['title']}：{state['changeRequest']}"
            if state.get("changeRequest")
            else f"{task['title']}：这是 Outline v{task['outlineVersion']} 下生成的页面内容。"
        ),
    }

    print(
        f"  -> {'复用已有产物' if existing_artifact else '生成产物'} {artifact_id}"
    )

    return {
        "pageTasks": [
            {
                **item,
                "attempts": attempts,
                "status": "completed",
                "currentArtifactId": artifact_id,
                "lastError": None,
            }
            if item["pageId"] == task["pageId"]
            else item
            for item in state.get("pageTasks", [])
        ],
        "artifacts": artifacts if existing_artifact else [*artifacts, artifact],
        "executionPath": _execution_path(state, f"completed:{task['pageId']}"),
    }


def route_after_page(state: PartialGenerationState) -> str:
    """当前队列还有页面时继续循环，否则汇总本次运行。"""

    return "select_page" if state.get("queue", []) else "summarize_run"


def summarize_run(state: PartialGenerationState) -> dict[str, Any]:
    """根据每一页的状态计算整项任务的结果。"""

    page_tasks = state.get("pageTasks", [])
    has_failed = any(task["status"] == "failed" for task in page_tasks)
    has_stale = any(task["status"] == "stale" for task in page_tasks)
    has_pending = any(task["status"] == "pending" for task in page_tasks)

    run_status = "completed"
    if has_stale:
        run_status = "waiting_generation"
    elif has_failed or has_pending:
        run_status = "partially_completed"

    print(f"[Python:summarize_run] 本次任务状态：{run_status}")

    return {
        "currentPageId": None,
        "runStatus": run_status,
        "executionPath": _execution_path(state, f"summarize:{run_status}"),
    }


def validate_export(state: PartialGenerationState) -> dict[str, Any]:
    """导出以前确认每一页都来自当前大纲和当前页面修订。"""

    invalid_pages: list[str] = []
    artifact_ids: list[str] = []

    for task in state.get("pageTasks", []):
        artifact = next(
            (
                item
                for item in state.get("artifacts", [])
                if item["artifactId"] == task["currentArtifactId"]
            ),
            None,
        )
        valid = (
            task["status"] == "completed"
            and artifact is not None
            and artifact["outlineVersion"] == state.get("outlineVersion")
            and artifact["pageRevision"] == task["pageRevision"]
        )

        if not valid:
            invalid_pages.append(task["pageId"])
            continue

        artifact_ids.append(artifact["artifactId"])

    if invalid_pages:
        reason = f"以下页面缺少当前版本的有效产物：{', '.join(invalid_pages)}"
        print(f"[Python:validate_export] 导出被阻止：{reason}")

        return {
            "runStatus": "export_blocked",
            "exportResult": {"ok": False, "reason": reason, "artifactIds": []},
            "executionPath": _execution_path(state, "export_blocked"),
        }

    print("[Python:validate_export] 版本校验通过，可以导出")
    return {
        "runStatus": "exported",
        "exportResult": {
            "ok": True,
            "reason": f"全部页面均来自 Outline v{state.get('outlineVersion')}",
            "artifactIds": artifact_ids,
        },
        "executionPath": _execution_path(state, "exported"),
    }


def create_partial_generation_workflow(*, checkpointer: Any) -> Any:
    """创建支持部分成功、局部重做和版本校验的页面制作流程。"""

    return (
        StateGraph(PartialGenerationState)
        .add_node("prepare_run", prepare_run)
        .add_node("select_page", select_page)
        .add_node("generate_page", generate_page)
        .add_node("summarize_run", summarize_run)
        .add_node("validate_export", validate_export)
        .add_edge(START, "prepare_run")
        .add_conditional_edges(
            "prepare_run",
            route_after_prepare,
            {
                "select_page": "select_page",
                "summarize_run": "summarize_run",
                "validate_export": "validate_export",
            },
        )
        .add_edge("select_page", "generate_page")
        .add_conditional_edges(
            "generate_page",
            route_after_page,
            {
                "select_page": "select_page",
                "summarize_run": "summarize_run",
            },
        )
        .add_edge("summarize_run", END)
        .add_edge("validate_export", END)
        .compile(checkpointer=checkpointer)
    )
