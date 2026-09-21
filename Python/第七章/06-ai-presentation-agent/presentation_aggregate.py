"""演示文稿聚合根：集中维护审核、页面、版本和导出规则。"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from presentation_theme import (
    create_generated_presentation_theme,
    create_page_style_override,
    create_presentation_theme,
)
from presentation_types import (
    CreatePresentationInput,
    EditableRequirements,
    ExportRecord,
    GeneratedPage,
    GeneratedPageStyle,
    GeneratedPresentationTheme,
    OutlineDraft,
    OutlineSlide,
    OutlineVersion,
    PageArtifact,
    PageTask,
    Presentation,
    ThemePreset,
    TimelineEvent,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class PresentationAggregate:
    """用领域方法而非 Controller 直接改字段，保证状态变化始终受规则约束。"""

    def __init__(self, value: Presentation) -> None:
        self._value = value

    @classmethod
    def create(cls, input_data: CreatePresentationInput) -> "PresentationAggregate":
        now = now_iso()
        presentation_id = f"PRES-{uuid4().hex[:8].upper()}"
        aggregate = cls(
            Presentation(
                id=presentation_id,
                threadId=f"presentation:{presentation_id}",
                modelMode=input_data.modelMode,
                status="creating_outline",
                requirements=input_data,
                theme=create_presentation_theme(),
                outlines=[],
                currentOutlineVersion=None,
                pages=[],
                timeline=[],
                exportRecord=None,
                createdAt=now,
                updatedAt=now,
            )
        )
        aggregate._event("task_created", f"创建演示文稿任务：{input_data.topic}")
        return aggregate

    @classmethod
    def restore(cls, value: Presentation) -> "PresentationAggregate":
        """恢复 JSONB 数据；Pydantic 默认值兼容缺少 modelMode 的早期任务。"""

        return cls(value.model_copy(deep=True))

    def to_model(self) -> Presentation:
        return self._value.model_copy(deep=True)

    @property
    def current_outline(self) -> OutlineVersion | None:
        return next(
            (
                outline
                for outline in self._value.outlines
                if outline.version == self._value.currentOutlineVersion
            ),
            None,
        )

    def update_requirements(self, next_requirements: EditableRequirements, instruction: str) -> None:
        """更新全局制作要求；新大纲生成时会由 add_outline 统一使旧页失效。"""

        self._value.requirements = self._value.requirements.model_copy(
            update=next_requirements.model_dump()
        )
        self._value.exportRecord = None
        self._event("requirements_updated", f"已更新制作要求：{instruction}")

    def change_theme(
        self,
        theme: ThemePreset | GeneratedPresentationTheme,
        instruction: str,
    ) -> None:
        """主题变化只影响预览与导出，不重新生成大纲和页面正文。"""

        revision = self._value.theme.revision + 1
        self._value.theme = (
            create_presentation_theme(theme, revision, instruction)
            if isinstance(theme, str)
            else create_generated_presentation_theme(theme, revision, instruction)
        )
        self._value.exportRecord = None
        if self._value.status == "exported":
            self._value.status = "completed"
        self._event("theme_updated", f"视觉主题已更新为“{self._value.theme.name}”")

    def change_page_style(
        self,
        page_id: str,
        style: GeneratedPageStyle,
        instruction: str,
    ) -> None:
        """单页样式只覆盖目标页，不需要重新生成该页正文。"""

        page = self.get_page(page_id)
        revision = (page.styleOverride.revision if page.styleOverride else 0) + 1
        page.styleOverride = create_page_style_override(style, revision, instruction)
        self._value.exportRecord = None
        if self._value.status == "exported":
            self._value.status = "completed"
        self._event("page_style_updated", f"第 {page.order} 页视觉样式已更新为 v{revision}")

    def add_outline(self, draft: OutlineDraft, feedback: str | None) -> OutlineVersion:
        """保存新大纲，并让旧版大纲和旧页面全部失效。"""

        version = (self._value.currentOutlineVersion or 0) + 1
        for outline in self._value.outlines:
            if outline.status in ("pending_review", "approved"):
                outline.status = "superseded"

        for page in self._value.pages:
            if page.status != "stale":
                page.status = "stale"
                page.lastError = f"页面属于 Outline v{page.outlineVersion}"

        outline = OutlineVersion(
            version=version,
            status="pending_review",
            title=draft.title,
            slides=[
                OutlineSlide(
                    pageId=f"page-{index}",
                    order=index,
                    **slide.model_dump(),
                )
                for index, slide in enumerate(draft.slides, start=1)
            ],
            feedback=feedback or None,
            createdAt=now_iso(),
            approvedAt=None,
        )
        self._value.outlines.append(outline)
        self._value.currentOutlineVersion = version
        self._value.status = "waiting_review"
        self._value.exportRecord = None
        event_type = "outline_generated" if version == 1 else "outline_revised"
        self._event(event_type, f"Outline v{version} 已生成，等待审核")
        return outline.model_copy(deep=True)

    def assert_reviewable(self, version: int) -> OutlineVersion:
        outline = self.current_outline
        if outline is None or outline.version != version:
            raise ValueError(f"Outline v{version} 已经过期，请审核当前版本。")
        if outline.status != "pending_review":
            raise ValueError(f"Outline v{version} 当前不能审核。")
        return outline

    def approve_outline(self, version: int) -> None:
        outline = self.assert_reviewable(version)
        outline.status = "approved"
        outline.approvedAt = now_iso()
        self._value.status = "generating_pages"
        self._event("outline_approved", f"Outline v{version} 已批准")

    def reject_outline(self, version: int, feedback: str) -> None:
        outline = self.assert_reviewable(version)
        outline.status = "rejected"
        outline.feedback = feedback or None
        self._value.status = "rejected"
        self._event("task_rejected", f"Outline v{version} 被拒绝，任务结束")

    def ensure_page_tasks(self) -> list[PageTask]:
        """只为已通过审核且尚未初始化的当前大纲创建页面任务。"""

        outline = self.current_outline
        if outline is None or outline.status != "approved":
            raise ValueError("只有通过审核的大纲才能创建页面任务。")

        existing = [page for page in self._value.pages if page.outlineVersion == outline.version]
        if existing:
            return deepcopy(existing)

        pages = [
            PageTask(
                pageId=slide.pageId,
                order=slide.order,
                title=slide.title,
                purpose=slide.purpose,
                outlineVersion=outline.version,
                pageRevision=1,
                status="pending",
                attempts=0,
                lastError=None,
                changeRequest=None,
                styleOverride=None,
                currentArtifactId=None,
                artifacts=[],
            )
            for slide in outline.slides
        ]
        self._value.pages.extend(pages)
        self._value.status = "generating_pages"
        self._touch()
        return deepcopy(pages)

    def get_current_pages(self) -> list[PageTask]:
        version = self._value.currentOutlineVersion
        return sorted(
            (page for page in self._value.pages if page.outlineVersion == version),
            key=lambda page: page.order,
        )

    def get_page(self, page_id: str) -> PageTask:
        page = next((item for item in self.get_current_pages() if item.pageId == page_id), None)
        if page is None:
            raise ValueError(f"没有找到当前版本页面：{page_id}")
        return page

    def start_page(self, page_id: str) -> PageTask:
        page = self.get_page(page_id)
        page.attempts += 1
        page.status = "generating"
        page.lastError = None
        self._value.status = "generating_pages"
        self._event("page_started", f"开始制作第 {page.order} 页：{page.title}")
        return page.model_copy(deep=True)

    def complete_page(self, page_id: str, content: GeneratedPage) -> None:
        page = self.get_page(page_id)
        artifact_id = ":".join(
            [
                self._value.id,
                f"outline-v{page.outlineVersion}",
                page.pageId,
                f"revision-{page.pageRevision}",
            ]
        )
        if not any(item.artifactId == artifact_id for item in page.artifacts):
            page.artifacts.append(
                PageArtifact(
                    artifactId=artifact_id,
                    outlineVersion=page.outlineVersion,
                    pageRevision=page.pageRevision,
                    createdAt=now_iso(),
                    **content.model_dump(),
                )
            )
        page.currentArtifactId = artifact_id
        page.status = "completed"
        page.lastError = None
        self._event("page_completed", f"第 {page.order} 页制作完成")
        self._refresh_status()

    def fail_page(self, page_id: str, message: str) -> None:
        page = self.get_page(page_id)
        page.status = "failed"
        page.lastError = message
        self._event("page_failed", f"第 {page.order} 页制作失败：{message}")
        self._refresh_status()

    def request_page_revision(self, page_id: str, change_request: str) -> PageTask:
        """只给目标页面创建新 Revision，其他页面的产物完全保留。"""

        page = self.get_page(page_id)
        if page.status != "completed":
            raise ValueError("只有已经完成的页面才能单独修改。")
        page.pageRevision += 1
        page.status = "pending"
        page.currentArtifactId = None
        page.lastError = None
        page.changeRequest = change_request
        self._value.status = "generating_pages"
        self._value.exportRecord = None
        self._event("page_revision_requested", f"第 {page.order} 页进入 Revision {page.pageRevision}")
        return page.model_copy(deep=True)

    def get_pending_page_ids(self) -> list[str]:
        return [
            page.pageId
            for page in self.get_current_pages()
            if page.status in ("pending", "failed", "stale")
        ]

    def assert_exportable(self) -> list[PageTask]:
        """导出前校验大纲、页面状态和产物版本没有混用。"""

        outline = self.current_outline
        if outline is None or outline.status != "approved":
            raise ValueError("当前大纲尚未通过审核，不能导出。")
        pages = self.get_current_pages()
        if len(pages) != len(outline.slides):
            raise ValueError("当前大纲的页面任务还没有全部创建。")

        invalid: list[PageTask] = []
        for page in pages:
            artifact = next(
                (item for item in page.artifacts if item.artifactId == page.currentArtifactId),
                None,
            )
            if (
                page.status != "completed"
                or artifact is None
                or artifact.outlineVersion != outline.version
                or artifact.pageRevision != page.pageRevision
            ):
                invalid.append(page)
        if invalid:
            pages_text = "、".join(f"{page.pageId}({page.status})" for page in invalid)
            raise ValueError(f"以下页面尚未满足导出条件：{pages_text}")
        return deepcopy(pages)

    def record_export(self, record: ExportRecord) -> None:
        self._value.exportRecord = record
        self._value.status = "exported"
        self._event("export_completed", f"已导出 {record.fileName}")

    def _refresh_status(self) -> None:
        pages = self.get_current_pages()
        has_incomplete = any(page.status != "completed" for page in pages)
        has_failed = any(page.status == "failed" for page in pages)
        self._value.status = (
            "partially_completed"
            if has_incomplete and has_failed
            else "generating_pages"
            if has_incomplete
            else "completed"
        )
        self._touch()

    def _event(self, event_type: str, message: str) -> None:
        self._value.timeline.append(
            TimelineEvent(
                id=str(uuid4()),
                type=event_type,
                message=message,
                createdAt=now_iso(),
            )
        )
        self._touch()

    def _touch(self) -> None:
        self._value.updatedAt = now_iso()
