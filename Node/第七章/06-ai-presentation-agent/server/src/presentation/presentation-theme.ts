import type {
	GeneratedPageStyle,
	GeneratedPresentationTheme,
	PageStyleOverride,
	PresentationTheme,
	ThemePreset
} from './presentation.types.js'

const presets: Record<
	ThemePreset,
	Omit<PresentationTheme, 'preset' | 'revision' | 'instruction'>
> = {
	editorial: {
		name: '编辑部',
		headFontFace: 'Microsoft YaHei',
		bodyFontFace: 'Microsoft YaHei',
		coverBackgroundColor: '182422',
		backgroundColor: 'F3F1EA',
		accentColor: 'E8573F',
		coverTextColor: 'F7F3EA',
		textColor: '182422',
		coverMutedColor: 'A8BBB5',
		mutedColor: '66706A',
		layoutStyle: 'side_bar',
		titleAlign: 'left',
		density: 'comfortable'
	},
	technology: {
		name: '深色科技',
		headFontFace: 'Microsoft YaHei',
		bodyFontFace: 'Microsoft YaHei',
		coverBackgroundColor: '081426',
		backgroundColor: 'EEF4FF',
		accentColor: '2F80ED',
		coverTextColor: 'F7FAFF',
		textColor: '10233F',
		coverMutedColor: '90A9C7',
		mutedColor: '526A87',
		layoutStyle: 'top_line',
		titleAlign: 'left',
		density: 'compact'
	},
	business: {
		name: '企业商务',
		headFontFace: 'Microsoft YaHei',
		bodyFontFace: 'Microsoft YaHei',
		coverBackgroundColor: '102A43',
		backgroundColor: 'F7FAFC',
		accentColor: '0F766E',
		coverTextColor: 'FFFFFF',
		textColor: '1A365D',
		coverMutedColor: 'B8CAD8',
		mutedColor: '627D98',
		layoutStyle: 'side_bar',
		titleAlign: 'left',
		density: 'comfortable'
	},
	warm: {
		name: '暖色活力',
		headFontFace: 'Microsoft YaHei',
		bodyFontFace: 'Microsoft YaHei',
		coverBackgroundColor: '3B1F2B',
		backgroundColor: 'FFF7ED',
		accentColor: 'E76F51',
		coverTextColor: 'FFF9F4',
		textColor: '42251E',
		coverMutedColor: 'D9B8AE',
		mutedColor: '8B6258',
		layoutStyle: 'corner_block',
		titleAlign: 'center',
		density: 'comfortable'
	}
}

function channel(hex: string, offset: number): number {
	return Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
}

function luminance(hex: string): number {
	const linear = [0, 2, 4].map((offset) => {
		const value = channel(hex, offset)
		return value <= 0.03928
			? value / 12.92
			: ((value + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(first: string, second: string): number {
	const [bright, dark] = [luminance(first), luminance(second)].sort(
		(a, b) => b - a
	)
	return (bright + 0.05) / (dark + 0.05)
}

function readableText(background: string): string {
	return contrast(background, 'FFFFFF') >= contrast(background, '182422')
		? 'FFFFFF'
		: '182422'
}

function ensureReadable(
	foreground: string,
	background: string,
	minimum = 4.5
): string {
	return contrast(foreground, background) >= minimum
		? foreground
		: readableText(background)
}

/** 根据预设创建一份可以持久化的视觉主题快照。 */
export function createPresentationTheme(
	preset: ThemePreset = 'editorial',
	revision = 1,
	instruction: string | null = null
): PresentationTheme {
	return {
		preset,
		revision,
		instruction,
		...presets[preset]
	}
}

/** 把模型生成的设计参数转换成安全、可持久化的主题快照。 */
export function createGeneratedPresentationTheme(
	input: GeneratedPresentationTheme,
	revision: number,
	instruction: string
): PresentationTheme {
	return {
		...input,
		preset: 'custom',
		revision,
		instruction,
		coverTextColor: ensureReadable(
			input.coverTextColor,
			input.coverBackgroundColor
		),
		textColor: ensureReadable(input.textColor, input.backgroundColor),
		coverMutedColor: ensureReadable(
			input.coverMutedColor,
			input.coverBackgroundColor,
			3
		),
		mutedColor: ensureReadable(input.mutedColor, input.backgroundColor, 3)
	}
}

/** 把单页设计参数转换成可安全覆盖全局主题的页面样式。 */
export function createPageStyleOverride(
	input: GeneratedPageStyle,
	revision: number,
	instruction: string
): PageStyleOverride {
	return {
		...input,
		revision,
		instruction,
		textColor: ensureReadable(input.textColor, input.backgroundColor),
		mutedColor: ensureReadable(input.mutedColor, input.backgroundColor, 3)
	}
}

/** 兼容早期任务中没有布局参数的主题数据。 */
export function restorePresentationTheme(
	theme?: Partial<PresentationTheme> | null
): PresentationTheme {
	if (!theme) return createPresentationTheme()
	const preset =
		theme.preset && theme.preset !== 'custom' ? theme.preset : 'editorial'
	const base = createPresentationTheme(
		preset,
		theme.revision ?? 1,
		theme.instruction ?? null
	)
	return {
		...base,
		...theme,
		preset: theme.preset ?? preset
	}
}
