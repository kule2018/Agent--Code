"""AI 演示文稿 Agent 的输入、领域数据和 API 输出模型。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ModelMode = Literal["replay", "ai"]
ThemePreset = Literal["editorial", "technology", "business", "warm"]
PresentationStatus = Literal[
    "creating_outline",
    "waiting_review",
    "generating_pages",
    "partially_completed",
    "completed",
    "rejected",
    "exported",
]
OutlineStatus = Literal["pending_review", "approved", "superseded", "rejected"]
PageStatus = Literal["pending", "generating", "completed", "failed", "stale"]
ChangeScope = Literal[
    "global_content",
    "visual_theme",
    "single_page",
    "single_page_style",
]


class CourseModel(BaseModel):
    """统一使用 camelCase，保证 Python API 与课程前端字段完全一致。"""

    model_config = ConfigDict(populate_by_name=True)


class EditableRequirements(CourseModel):
    topic: str = Field(min_length=2, max_length=120)
    audience: str = Field(min_length=2, max_length=120)
    pageCount: int = Field(ge=3, le=12)
    additionalRequirements: str = Field(default="", max_length=1000)

    @field_validator("topic", "audience", "additionalRequirements")
    @classmethod
    def trim_text(cls, value: str) -> str:
        return value.strip()


class CreatePresentationInput(EditableRequirements):
    modelMode: ModelMode = "replay"
    sourceText: str = Field(min_length=20, max_length=60_000)
    sourceName: str = Field(default="粘贴内容", min_length=1, max_length=160)

    @field_validator("sourceText", "sourceName")
    @classmethod
    def trim_source(cls, value: str) -> str:
        return value.strip()


class ReviewOutlineInput(CourseModel):
    decision: Literal["approve", "revise", "reject"]
    outlineVersion: int = Field(gt=0)
    feedback: str = Field(default="", max_length=1000)

    @field_validator("feedback")
    @classmethod
    def trim_feedback(cls, value: str) -> str:
        return value.strip()


class RevisePageInput(CourseModel):
    changeRequest: str = Field(min_length=2, max_length=1000)

    @field_validator("changeRequest")
    @classmethod
    def trim_request(cls, value: str) -> str:
        return value.strip()


class ApplyChangeInput(CourseModel):
    instruction: str = Field(min_length=2, max_length=1000)

    @field_validator("instruction")
    @classmethod
    def trim_instruction(cls, value: str) -> str:
        return value.strip()


class GeneratedPresentationTheme(CourseModel):
    name: str = Field(min_length=2, max_length=20)
    headFontFace: Literal["Microsoft YaHei", "PingFang SC", "DengXian", "SimHei"]
    bodyFontFace: Literal["Microsoft YaHei", "PingFang SC", "DengXian", "SimHei"]
    coverBackgroundColor: str
    backgroundColor: str
    accentColor: str
    coverTextColor: str
    textColor: str
    coverMutedColor: str
    mutedColor: str
    layoutStyle: Literal["side_bar", "top_line", "corner_block"]
    titleAlign: Literal["left", "center"]
    density: Literal["comfortable", "compact"]

    @field_validator(
        "coverBackgroundColor",
        "backgroundColor",
        "accentColor",
        "coverTextColor",
        "textColor",
        "coverMutedColor",
        "mutedColor",
    )
    @classmethod
    def validate_color(cls, value: str) -> str:
        value = value.strip().upper()
        if len(value) != 6 or any(char not in "0123456789ABCDEF" for char in value):
            raise ValueError("颜色必须是 6 位十六进制色值")
        return value


class GeneratedPageStyle(CourseModel):
    headFontFace: Literal["Microsoft YaHei", "PingFang SC", "DengXian", "SimHei"]
    bodyFontFace: Literal["Microsoft YaHei", "PingFang SC", "DengXian", "SimHei"]
    backgroundColor: str
    accentColor: str
    textColor: str
    mutedColor: str
    layoutStyle: Literal["side_bar", "top_line", "corner_block"]
    titleAlign: Literal["left", "center"]
    density: Literal["comfortable", "compact"]

    @field_validator("backgroundColor", "accentColor", "textColor", "mutedColor")
    @classmethod
    def validate_color(cls, value: str) -> str:
        value = value.strip().upper()
        if len(value) != 6 or any(char not in "0123456789ABCDEF" for char in value):
            raise ValueError("颜色必须是 6 位十六进制色值")
        return value


class PresentationTheme(GeneratedPresentationTheme):
    preset: ThemePreset | Literal["custom"]
    revision: int
    instruction: str | None


class PageStyleOverride(GeneratedPageStyle):
    revision: int
    instruction: str


class OutlineSlide(CourseModel):
    pageId: str
    order: int
    title: str
    purpose: str
    keyPoints: list[str] = Field(min_length=2, max_length=5)


class OutlineDraft(CourseModel):
    title: str
    slides: list["OutlineDraftSlide"]


class OutlineDraftSlide(CourseModel):
    title: str
    purpose: str
    keyPoints: list[str] = Field(min_length=2, max_length=5)


class OutlineVersion(CourseModel):
    version: int
    status: OutlineStatus
    title: str
    slides: list[OutlineSlide]
    feedback: str | None
    createdAt: str
    approvedAt: str | None


class GeneratedPage(CourseModel):
    title: str
    subtitle: str
    bullets: list[str] = Field(min_length=2, max_length=5)
    speakerNote: str


class PageArtifact(GeneratedPage):
    artifactId: str
    outlineVersion: int
    pageRevision: int
    createdAt: str


class PageTask(CourseModel):
    pageId: str
    order: int
    title: str
    purpose: str
    outlineVersion: int
    pageRevision: int
    status: PageStatus
    attempts: int
    lastError: str | None
    changeRequest: str | None
    styleOverride: PageStyleOverride | None
    currentArtifactId: str | None
    artifacts: list[PageArtifact]


class TimelineEvent(CourseModel):
    id: str
    type: str
    message: str
    createdAt: str


class ExportRecord(CourseModel):
    fileName: str
    filePath: str
    outlineVersion: int
    pageArtifactIds: list[str]
    createdAt: str


class Presentation(CourseModel):
    id: str
    threadId: str
    modelMode: ModelMode = "replay"
    status: PresentationStatus
    requirements: CreatePresentationInput
    theme: PresentationTheme
    outlines: list[OutlineVersion]
    currentOutlineVersion: int | None
    pages: list[PageTask]
    timeline: list[TimelineEvent]
    exportRecord: ExportRecord | None
    createdAt: str
    updatedAt: str


class PresentationChangePlan(CourseModel):
    scope: ChangeScope
    reason: str
    nextRequirements: EditableRequirements | None
    themePreset: ThemePreset | None
    generatedTheme: GeneratedPresentationTheme | None
    generatedPageStyle: GeneratedPageStyle | None
    targetPageNumber: int | None
    pageInstruction: str | None
