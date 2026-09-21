"""演示文稿主题预设、颜色对比度校验和页面样式覆盖。"""

from __future__ import annotations

from presentation_types import (
    GeneratedPageStyle,
    GeneratedPresentationTheme,
    PageStyleOverride,
    PresentationTheme,
    ThemePreset,
)


PRESETS: dict[ThemePreset, dict[str, str]] = {
    "editorial": {
        "name": "编辑部",
        "headFontFace": "Microsoft YaHei",
        "bodyFontFace": "Microsoft YaHei",
        "coverBackgroundColor": "182422",
        "backgroundColor": "F3F1EA",
        "accentColor": "E8573F",
        "coverTextColor": "F7F3EA",
        "textColor": "182422",
        "coverMutedColor": "A8BBB5",
        "mutedColor": "66706A",
        "layoutStyle": "side_bar",
        "titleAlign": "left",
        "density": "comfortable",
    },
    "technology": {
        "name": "深色科技",
        "headFontFace": "Microsoft YaHei",
        "bodyFontFace": "Microsoft YaHei",
        "coverBackgroundColor": "081426",
        "backgroundColor": "EEF4FF",
        "accentColor": "2F80ED",
        "coverTextColor": "F7FAFF",
        "textColor": "10233F",
        "coverMutedColor": "90A9C7",
        "mutedColor": "526A87",
        "layoutStyle": "top_line",
        "titleAlign": "left",
        "density": "compact",
    },
    "business": {
        "name": "企业商务",
        "headFontFace": "Microsoft YaHei",
        "bodyFontFace": "Microsoft YaHei",
        "coverBackgroundColor": "102A43",
        "backgroundColor": "F7FAFC",
        "accentColor": "0F766E",
        "coverTextColor": "FFFFFF",
        "textColor": "1A365D",
        "coverMutedColor": "B8CAD8",
        "mutedColor": "627D98",
        "layoutStyle": "side_bar",
        "titleAlign": "left",
        "density": "comfortable",
    },
    "warm": {
        "name": "暖色活力",
        "headFontFace": "Microsoft YaHei",
        "bodyFontFace": "Microsoft YaHei",
        "coverBackgroundColor": "3B1F2B",
        "backgroundColor": "FFF7ED",
        "accentColor": "E76F51",
        "coverTextColor": "FFF9F4",
        "textColor": "42251E",
        "coverMutedColor": "D9B8AE",
        "mutedColor": "8B6258",
        "layoutStyle": "corner_block",
        "titleAlign": "center",
        "density": "comfortable",
    },
}


def _channel(hex_color: str, offset: int) -> float:
    return int(hex_color[offset : offset + 2], 16) / 255


def _luminance(hex_color: str) -> float:
    values = []
    for offset in (0, 2, 4):
        value = _channel(hex_color, offset)
        values.append(value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]


def contrast(first: str, second: str) -> float:
    """计算两个不带 # 的十六进制色值的 WCAG 对比度。"""

    bright, dark = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (bright + 0.05) / (dark + 0.05)


def _readable_text(background: str) -> str:
    return "FFFFFF" if contrast(background, "FFFFFF") >= contrast(background, "182422") else "182422"


def ensure_readable(foreground: str, background: str, minimum: float = 4.5) -> str:
    """模型给出的颜色不够清晰时，自动替换为安全的深色或白色。"""

    return foreground if contrast(foreground, background) >= minimum else _readable_text(background)


def create_presentation_theme(
    preset: ThemePreset = "editorial",
    revision: int = 1,
    instruction: str | None = None,
) -> PresentationTheme:
    """根据预设创建可持久化的主题快照。"""

    return PresentationTheme(
        preset=preset,
        revision=revision,
        instruction=instruction,
        **PRESETS[preset],
    )


def create_generated_presentation_theme(
    input_theme: GeneratedPresentationTheme,
    revision: int,
    instruction: str,
) -> PresentationTheme:
    """把模型生成的设计参数转换成通过可读性校验的主题快照。"""

    data = input_theme.model_dump()
    data.update(
        {
            "preset": "custom",
            "revision": revision,
            "instruction": instruction,
            "coverTextColor": ensure_readable(
                data["coverTextColor"],
                data["coverBackgroundColor"],
            ),
            "textColor": ensure_readable(data["textColor"], data["backgroundColor"]),
            "coverMutedColor": ensure_readable(
                data["coverMutedColor"],
                data["coverBackgroundColor"],
                3,
            ),
            "mutedColor": ensure_readable(data["mutedColor"], data["backgroundColor"], 3),
        }
    )
    return PresentationTheme(**data)


def create_page_style_override(
    input_style: GeneratedPageStyle,
    revision: int,
    instruction: str,
) -> PageStyleOverride:
    """把单页设计参数转换成可安全覆盖全局主题的页面样式。"""

    data = input_style.model_dump()
    data.update(
        {
            "revision": revision,
            "instruction": instruction,
            "textColor": ensure_readable(data["textColor"], data["backgroundColor"]),
            "mutedColor": ensure_readable(data["mutedColor"], data["backgroundColor"], 3),
        }
    )
    return PageStyleOverride(**data)
