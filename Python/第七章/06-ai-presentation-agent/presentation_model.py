"""Replay 与 DeepSeek 两种内容提供方。

Replay 只替代模型输出，审核、持久化、版本校验与 PPTX 导出仍使用真实业务链路，
因此课堂演示不需要任何模型密钥。
"""

from __future__ import annotations

import json
import os
import re
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from presentation_types import (
    CreatePresentationInput,
    EditableRequirements,
    GeneratedPage,
    GeneratedPageStyle,
    GeneratedPresentationTheme,
    OutlineDraft,
    OutlineDraftSlide,
    OutlineVersion,
    PageTask,
    Presentation,
    PresentationChangePlan,
)


class ModelProvider(Protocol):
    """业务工作流只依赖这个接口，不关心使用 Replay 还是真实模型。"""

    mode: str

    def plan_change(self, instruction: str, presentation: Presentation) -> PresentationChangePlan: ...

    def generate_outline(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        version: int,
        previous_outline: OutlineVersion | None,
        feedback: str | None,
    ) -> OutlineDraft: ...

    def generate_page(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        outline: OutlineVersion,
        page: PageTask,
    ) -> GeneratedPage: ...


def editable_requirements(presentation: Presentation) -> EditableRequirements:
    requirements = presentation.requirements
    return EditableRequirements(
        topic=requirements.topic,
        audience=requirements.audience,
        pageCount=requirements.pageCount,
        additionalRequirements=requirements.additionalRequirements,
    )


def append_requirement(current: str, instruction: str) -> str:
    return "；".join(item for item in (current.strip(), instruction.strip()) if item)[:1000]


def extract_replacement(instruction: str, field: str) -> str | None:
    pattern = rf"(?:{field})\s*(?:改为|改成|换成|调整为|设为)\s*[“\"']?([^，。；;\n”\"']+)"
    match = re.search(pattern, instruction)
    return match.group(1).strip() if match else None


def is_visual_instruction(instruction: str) -> bool:
    return bool(
        re.search(
            r"配色|颜色|背景|字体|视觉|深色|浅色|科技蓝|商务蓝|暖色|杂志风|版式|居中|左对齐|紧凑",
            instruction,
        )
    )


def replay_page_style(instruction: str) -> GeneratedPageStyle:
    """Replay 用确定性规则生成单页视觉样式，方便重复演示。"""

    if "绿" in instruction:
        colors = {
            "backgroundColor": "12372A",
            "accentColor": "8DBF67",
            "textColor": "FFFFFF",
            "mutedColor": "B8D4C4",
        }
    elif re.search(r"红|橙|暖", instruction):
        colors = {
            "backgroundColor": "5B2432",
            "accentColor": "F08A5D",
            "textColor": "FFF9F4",
            "mutedColor": "E6C6C1",
        }
    else:
        colors = {
            "backgroundColor": "102A43",
            "accentColor": "56CCF2",
            "textColor": "FFFFFF",
            "mutedColor": "B8CAD8",
        }

    return GeneratedPageStyle(
        headFontFace="Microsoft YaHei",
        bodyFontFace="Microsoft YaHei",
        **colors,
        layoutStyle="top_line"
        if re.search(r"顶部|横线", instruction)
        else "corner_block"
        if re.search(r"区块|色块", instruction)
        else "side_bar",
        titleAlign="center" if "居中" in instruction else "left",
        density="compact" if re.search(r"紧凑|信息多", instruction) else "comfortable",
    )


def replay_change_plan(instruction: str, presentation: Presentation) -> PresentationChangePlan:
    """把课程常用的中文修改指令映射到四种明确的业务范围。"""

    page_match = re.search(r"第\s*(\d+)\s*页", instruction)
    if page_match and is_visual_instruction(instruction):
        page_number = int(page_match.group(1))
        return PresentationChangePlan(
            scope="single_page_style",
            reason=f"修改要求明确指定了第 {page_number} 页的视觉样式。",
            nextRequirements=None,
            themePreset=None,
            generatedTheme=None,
            generatedPageStyle=replay_page_style(instruction),
            targetPageNumber=page_number,
            pageInstruction=instruction,
        )
    if page_match:
        page_number = int(page_match.group(1))
        return PresentationChangePlan(
            scope="single_page",
            reason=f"修改要求明确指向第 {page_number} 页。",
            nextRequirements=None,
            themePreset=None,
            generatedTheme=None,
            generatedPageStyle=None,
            targetPageNumber=page_number,
            pageInstruction=instruction,
        )
    if is_visual_instruction(instruction):
        preset = (
            "technology"
            if re.search(r"科技|深色|蓝色|科技蓝", instruction)
            else "business"
            if re.search(r"商务|专业|企业蓝", instruction)
            else "warm"
            if re.search(r"暖|活力|橙|红", instruction)
            else "editorial"
        )
        return PresentationChangePlan(
            scope="visual_theme",
            reason="修改要求描述了整套演示文稿的视觉风格。",
            nextRequirements=None,
            themePreset=preset,
            generatedTheme=None,
            generatedPageStyle=None,
            targetPageNumber=None,
            pageInstruction=None,
        )

    current = editable_requirements(presentation)
    topic = extract_replacement(instruction, r"(?:演示)?主题|标题") or current.topic
    audience = extract_replacement(instruction, "目标观众|受众") or current.audience
    exact_count = re.search(r"(?:改成|调整为|设为)\s*(\d+)\s*页", instruction)
    page_count = int(exact_count.group(1)) if exact_count else current.pageCount
    if "增加一页" in instruction:
        page_count += 1
    if "减少一页" in instruction:
        page_count -= 1

    return PresentationChangePlan(
        scope="global_content",
        reason="修改要求会影响整份演示文稿的主题、受众、页数或内容方向。",
        nextRequirements=EditableRequirements(
            topic=topic,
            audience=audience,
            pageCount=max(3, min(12, page_count)),
            additionalRequirements=append_requirement(current.additionalRequirements, instruction),
        ),
        themePreset=None,
        generatedTheme=None,
        generatedPageStyle=None,
        targetPageNumber=None,
        pageInstruction=None,
    )


REPLAY_SLIDE_TEMPLATES = [
    (
        "为什么现在需要可靠的 Agent 工作流",
        "从长任务失败、人工确认和服务中断三个问题切入。",
        ["模型调用会失败", "业务任务会持续很久", "关键节点需要人工确认"],
    ),
    (
        "从一次调用升级为持久化执行",
        "说明 Checkpoint 如何保存工作流进度。",
        ["Node 完成后保存状态", "服务重启后恢复 Thread", "避免重复执行已完成步骤"],
    ),
    (
        "页面任务的部分成功与局部重做",
        "展示页面级任务如何独立记录结果。",
        ["成功页面继续保留", "失败页面单独续做", "单页修改产生新 Revision"],
    ),
    (
        "Human-in-the-Loop 风险控制",
        "说明生成内容怎样经过人工审核后继续。",
        ["大纲生成后暂停", "批准、修改与拒绝", "过期版本不能推动流程"],
    ),
    (
        "版本一致性与最终交付",
        "展示导出前的版本与完整性校验。",
        ["只使用当前大纲页面", "检查最新页面产物", "导出可编辑 PPTX"],
    ),
    (
        "企业落地建议",
        "给出从课程案例走向真实系统的扩展方向。",
        ["增加模板与品牌资产", "接入对象存储", "补充权限、审计与成本预算"],
    ),
]


class ReplayPresentationProvider:
    """课程默认 Provider：返回固定内容，便于稳定复现实验结果。"""

    mode = "replay"

    def plan_change(self, instruction: str, presentation: Presentation) -> PresentationChangePlan:
        return replay_change_plan(instruction, presentation)

    def generate_outline(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        version: int,
        previous_outline: OutlineVersion | None,
        feedback: str | None,
    ) -> OutlineDraft:
        requirements = (
            editable_requirements(requirements)
            if isinstance(requirements, Presentation)
            else requirements
        )
        slides: list[OutlineDraftSlide] = []
        for index in range(requirements.pageCount):
            title, purpose, points = REPLAY_SLIDE_TEMPLATES[index % len(REPLAY_SLIDE_TEMPLATES)]
            if feedback and "成本" in feedback and index == 2:
                title = "实施成本与资源投入"
                purpose = "响应修改要求，说明项目落地所需的人力与系统资源。"
                points = ["模型调用与基础设施成本", "研发和运营投入", "分阶段控制实施范围"]
            elif version > 1 and index == min(3, requirements.pageCount - 1):
                title = "企业 Agent 的风险控制与持久化执行"
                purpose = "响应修改意见，补充人工审核、断点恢复和执行边界。"
                points = ["高风险节点进入人工审核", "Checkpoint 保存可恢复进度", "版本校验阻止旧结果继续流转"]
            slides.append(OutlineDraftSlide(title=title, purpose=purpose, keyPoints=points))
        return OutlineDraft(
            title=f"{requirements.topic}：企业落地版" if version > 1 else requirements.topic,
            slides=slides,
        )

    def generate_page(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        outline: OutlineVersion,
        page: PageTask,
    ) -> GeneratedPage:
        requirements = (
            editable_requirements(requirements)
            if isinstance(requirements, Presentation)
            else requirements
        )
        slide = next((item for item in outline.slides if item.pageId == page.pageId), None)
        if slide is None:
            raise ValueError("当前大纲中没有找到页面内容。")
        bullets = list(slide.keyPoints)
        if page.changeRequest:
            bullets[0] = page.changeRequest
        return GeneratedPage(
            title=slide.title,
            subtitle=f"{requirements.audience} · Outline v{outline.version}",
            bullets=bullets,
            speakerNote=f"本页用于{slide.purpose}。",
        )


class DeepSeekPresentationProvider:
    """真实 AI 模式：使用 DeepSeek OpenAI 兼容接口返回结构化 JSON。"""

    mode = "ai"
    endpoint = "https://api.deepseek.com/chat/completions"

    def __init__(self) -> None:
        self.api_key = os.getenv("DEEPSEEK_API_KEY")
        if not self.api_key:
            raise ValueError("AI 模式需要配置 DEEPSEEK_API_KEY。")
        self.model = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")

    def _request_json(self, system: str, payload: dict[str, object]) -> dict[str, object]:
        body = json.dumps(
            {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
                "stream": False,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            self.endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=60) as response:
                result = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            raise RuntimeError(f"DeepSeek 请求失败：HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError(f"DeepSeek 连接失败：{error.reason}") from error

        try:
            content = result["choices"][0]["message"]["content"]
            return json.loads(content)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
            raise RuntimeError("DeepSeek 没有返回可解析的 JSON 结果。") from error

    def plan_change(self, instruction: str, presentation: Presentation) -> PresentationChangePlan:
        result = self._request_json(
            "你负责把用户对演示文稿的自然语言修改要求转换成 JSON 修改计划。"
            "scope 只能是 global_content、visual_theme、single_page、single_page_style。"
            "只选择一种 scope；没有使用的字段必须为 null。"
            "如果有页码和视觉要求，必须选择 single_page_style。颜色必须是无 # 的六位十六进制值。",
            {
                "instruction": instruction,
                "currentRequirements": editable_requirements(presentation).model_dump(),
                "currentTheme": presentation.theme.model_dump(),
                "currentPages": [
                    {"pageNumber": page.order, "title": page.title, "status": page.status}
                    for page in presentation.pages
                    if page.outlineVersion == presentation.currentOutlineVersion
                ],
            },
        )
        plan = PresentationChangePlan.model_validate(result)
        if plan.scope == "visual_theme" and plan.generatedTheme is None:
            fallback = replay_change_plan(instruction, presentation)
            if fallback.scope != "visual_theme":
                raise ValueError("模型没有返回完整的视觉主题配置。")
            return fallback.model_copy(update={"reason": "模型没有返回完整主题，已使用最接近的安全预设。"})
        if plan.scope == "single_page_style" and plan.generatedPageStyle is None:
            if plan.targetPageNumber is None:
                raise ValueError("模型没有返回需要修改的页码。")
            return plan.model_copy(
                update={
                    "generatedPageStyle": replay_page_style(instruction),
                    "reason": "模型没有返回完整单页样式，已使用安全样式补全。",
                }
            )
        return plan

    def generate_outline(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        version: int,
        previous_outline: OutlineVersion | None,
        feedback: str | None,
    ) -> OutlineDraft:
        requirements = (
            editable_requirements(requirements)
            if isinstance(requirements, Presentation)
            else requirements
        )
        result = OutlineDraft.model_validate(
            self._request_json(
                "你是企业演示文稿内容策划。根据资料生成结构清晰、每页职责不同的大纲。"
                "只使用输入中的事实，不要虚构数据。返回 JSON：title 和 slides。",
                {
                    "requirements": requirements.model_dump(),
                    "version": version,
                    "previousOutline": previous_outline.model_dump() if previous_outline else None,
                    "feedback": feedback,
                },
            )
        )
        if len(result.slides) != requirements.pageCount:
            raise ValueError(f"模型返回 {len(result.slides)} 页，但任务要求 {requirements.pageCount} 页。")
        return result

    def generate_page(
        self,
        requirements: CreatePresentationInput | EditableRequirements | Presentation,
        outline: OutlineVersion,
        page: PageTask,
    ) -> GeneratedPage:
        requirements = (
            editable_requirements(requirements)
            if isinstance(requirements, Presentation)
            else requirements
        )
        return GeneratedPage.model_validate(
            self._request_json(
                "你是企业演示文稿编辑。只生成当前页，内容必须符合已批准大纲和参考资料。"
                "bullet 要简洁，不要写无法核验的数据。返回 JSON：title、subtitle、bullets、speakerNote。",
                {
                    "requirements": requirements.model_dump(),
                    "outline": outline.model_dump(),
                    "page": page.model_dump(),
                },
            )
        )


class PresentationModelService:
    """根据任务创建时保存的模式返回对应 Provider。"""

    def __init__(self) -> None:
        self._replay_provider = ReplayPresentationProvider()
        self._ai_provider: DeepSeekPresentationProvider | None = None

    def get_provider(self, mode: str) -> ModelProvider:
        if mode == "replay":
            return self._replay_provider
        if self._ai_provider is None:
            self._ai_provider = DeepSeekPresentationProvider()
        return self._ai_provider

    @property
    def ai_available(self) -> bool:
        return bool(os.getenv("DEEPSEEK_API_KEY"))
