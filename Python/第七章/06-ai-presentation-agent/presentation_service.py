"""API 层与领域/工作流层之间的应用服务。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from presentation_aggregate import PresentationAggregate
from presentation_model import PresentationModelService
from presentation_repository import PresentationRepository
from presentation_types import (
    ApplyChangeInput,
    CreatePresentationInput,
    Presentation,
    PresentationChangePlan,
    ReviewOutlineInput,
)

if TYPE_CHECKING:
    from presentation_graph import PresentationGraphService


class PresentationService:
    def __init__(
        self,
        repository: PresentationRepository,
        graph: "PresentationGraphService",
        models: PresentationModelService,
    ) -> None:
        self.repository = repository
        self.graph = graph
        self.models = models

    def get_meta(self) -> dict[str, object]:
        return {
            "defaultMode": "ai" if os.getenv("MODEL_MODE") == "ai" else "replay",
            "aiAvailable": self.models.ai_available,
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        }

    def create(self, input_data: CreatePresentationInput) -> Presentation:
        aggregate = PresentationAggregate.create(input_data)
        self.repository.save(aggregate.to_model())
        self.graph.start(aggregate.to_model().id)
        return self.get(aggregate.to_model().id)

    def list(self) -> list[Presentation]:
        return self.repository.list()

    def get(self, presentation_id: str) -> Presentation:
        presentation = self.repository.find_by_id(presentation_id)
        if presentation is None:
            raise ValueError(f"没有找到演示文稿任务：{presentation_id}")
        return presentation

    def review(self, presentation_id: str, input_data: ReviewOutlineInput) -> Presentation:
        self.graph.review(presentation_id, input_data)
        return self.get(presentation_id)

    def continue_pages(self, presentation_id: str) -> Presentation:
        self.graph.continue_pages(presentation_id)
        return self.get(presentation_id)

    def revise_page(self, presentation_id: str, page_id: str, change_request: str) -> Presentation:
        self.graph.revise_page(presentation_id, page_id, change_request)
        return self.get(presentation_id)

    def apply_change(
        self,
        presentation_id: str,
        input_data: ApplyChangeInput,
    ) -> tuple[Presentation, PresentationChangePlan]:
        """根据修改范围选择全局重建、主题切换、单页重做或单页样式覆盖。"""

        presentation = self.get(presentation_id)
        if presentation.status == "rejected":
            raise ValueError("任务已经被拒绝，请重新创建演示文稿。")

        provider = self.models.get_provider(presentation.modelMode)
        plan = provider.plan_change(input_data.instruction, presentation)

        if plan.scope == "global_content":
            if plan.nextRequirements is None:
                raise ValueError("修改计划缺少新的全局制作要求。")
            self.graph.revise_requirements(
                presentation_id,
                plan.nextRequirements,
                input_data.instruction,
            )

        elif plan.scope == "visual_theme":
            theme = plan.generatedTheme or plan.themePreset
            if theme is None:
                raise ValueError("修改计划缺少视觉主题。")
            aggregate = PresentationAggregate.restore(presentation)
            aggregate.change_theme(theme, input_data.instruction)
            self.repository.save(aggregate.to_model())

        elif plan.scope == "single_page":
            if plan.targetPageNumber is None or not plan.pageInstruction:
                raise ValueError("修改计划缺少目标页码或单页修改要求。")
            page = next(
                (
                    item
                    for item in presentation.pages
                    if item.outlineVersion == presentation.currentOutlineVersion
                    and item.order == plan.targetPageNumber
                ),
                None,
            )
            if page is None:
                raise ValueError(f"当前版本中没有第 {plan.targetPageNumber} 页。")
            self.graph.revise_page(presentation_id, page.pageId, plan.pageInstruction)

        elif plan.scope == "single_page_style":
            if plan.targetPageNumber is None or plan.generatedPageStyle is None:
                raise ValueError("修改计划缺少目标页码或单页样式。")
            page = next(
                (
                    item
                    for item in presentation.pages
                    if item.outlineVersion == presentation.currentOutlineVersion
                    and item.order == plan.targetPageNumber
                ),
                None,
            )
            if page is None:
                raise ValueError(f"当前版本中没有第 {plan.targetPageNumber} 页。")
            aggregate = PresentationAggregate.restore(presentation)
            aggregate.change_page_style(page.pageId, plan.generatedPageStyle, input_data.instruction)
            self.repository.save(aggregate.to_model())

        return self.get(presentation_id), plan

    def export(self, presentation_id: str) -> Presentation:
        self.graph.export(presentation_id)
        return self.get(presentation_id)

    def get_download(self, presentation_id: str) -> tuple[Path, str]:
        presentation = self.get(presentation_id)
        if presentation.exportRecord is None:
            raise ValueError("当前任务还没有导出文件。")
        path = Path(presentation.exportRecord.filePath)
        if not path.is_file():
            raise ValueError("导出记录存在，但实际文件已经丢失。")
        return path, presentation.exportRecord.fileName
