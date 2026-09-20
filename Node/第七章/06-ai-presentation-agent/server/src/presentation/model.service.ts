import { Injectable } from '@nestjs/common'
import { ChatDeepSeek } from '@langchain/deepseek'
import * as z from 'zod'
import {
	EditableRequirementsSchema,
	GeneratedPageStyleSchema,
	GeneratedPresentationThemeSchema,
	ThemePresetSchema
} from './presentation.types.js'
import type {
	EditablePresentationRequirements,
	GeneratedPage,
	ModelProvider,
	OutlineDraft,
	OutlineVersion,
	PageTask,
	Presentation,
	PresentationChangePlan,
	PresentationRequirements
} from './presentation.types.js'

const OutlineDraftSchema = z.object({
	title: z.string(),
	slides: z.array(
		z.object({
			title: z.string(),
			purpose: z.string(),
			keyPoints: z.array(z.string()).min(2).max(5)
		})
	)
})

const GeneratedPageSchema = z.object({
	title: z.string(),
	subtitle: z.string(),
	bullets: z.array(z.string()).min(2).max(5),
	speakerNote: z.string()
})

const PresentationChangePlanSchema = z.object({
	scope: z.enum([
		'global_content',
		'visual_theme',
		'single_page',
		'single_page_style'
	]),
	reason: z.string(),
	nextRequirements: EditableRequirementsSchema.nullable(),
	themePreset: ThemePresetSchema.nullable(),
	generatedTheme: GeneratedPresentationThemeSchema.nullable(),
	generatedPageStyle: GeneratedPageStyleSchema.nullable(),
	targetPageNumber: z.number().int().min(1).max(12).nullable(),
	pageInstruction: z.string().nullable()
})

function editableRequirements(
	presentation: Presentation
): EditablePresentationRequirements {
	const { topic, audience, pageCount, additionalRequirements } =
		presentation.requirements
	return { topic, audience, pageCount, additionalRequirements }
}

function appendRequirement(current: string, instruction: string): string {
	return [current.trim(), instruction.trim()].filter(Boolean).join('；').slice(0, 1000)
}

function extractReplacement(instruction: string, field: string): string | null {
	const pattern = new RegExp(
		`(?:${field})\\s*(?:改为|改成|换成|调整为|设为)\\s*[“"']?([^，。；;\\n”"']+)`
	)
	return instruction.match(pattern)?.[1]?.trim() ?? null
}

function isVisualInstruction(instruction: string): boolean {
	return /配色|颜色|背景|字体|视觉|深色|浅色|科技蓝|商务蓝|暖色|杂志风|版式|居中|左对齐|紧凑/.test(
		instruction
	)
}

function replayPageStyle(instruction: string) {
	const colors = /绿/.test(instruction)
		? {
				backgroundColor: '12372A',
				accentColor: '8DBF67',
				textColor: 'FFFFFF',
				mutedColor: 'B8D4C4'
			}
		: /红|橙|暖/.test(instruction)
			? {
					backgroundColor: '5B2432',
					accentColor: 'F08A5D',
					textColor: 'FFF9F4',
					mutedColor: 'E6C6C1'
				}
			: {
					backgroundColor: '102A43',
					accentColor: '56CCF2',
					textColor: 'FFFFFF',
					mutedColor: 'B8CAD8'
				}

	return {
		headFontFace: 'Microsoft YaHei' as const,
		bodyFontFace: 'Microsoft YaHei' as const,
		...colors,
		layoutStyle: /顶部|横线/.test(instruction)
			? ('top_line' as const)
			: /区块|色块/.test(instruction)
				? ('corner_block' as const)
				: ('side_bar' as const),
		titleAlign: /居中/.test(instruction)
			? ('center' as const)
			: ('left' as const),
		density: /紧凑|信息多/.test(instruction)
			? ('compact' as const)
			: ('comfortable' as const)
	}
}

function replayChangePlan(
	instruction: string,
	presentation: Presentation
): PresentationChangePlan {
	const pageMatch = instruction.match(/第\s*(\d+)\s*页/)
	if (pageMatch && isVisualInstruction(instruction)) {
		return {
			scope: 'single_page_style',
			reason: `修改要求明确指定了第 ${pageMatch[1]} 页的视觉样式。`,
			nextRequirements: null,
			themePreset: null,
			generatedTheme: null,
			generatedPageStyle: replayPageStyle(instruction),
			targetPageNumber: Number(pageMatch[1]),
			pageInstruction: instruction
		}
	}
	if (pageMatch) {
		return {
			scope: 'single_page',
			reason: `修改要求明确指向第 ${pageMatch[1]} 页。`,
			nextRequirements: null,
			themePreset: null,
			generatedTheme: null,
			generatedPageStyle: null,
			targetPageNumber: Number(pageMatch[1]),
			pageInstruction: instruction
		}
	}

	if (isVisualInstruction(instruction)) {
		const themePreset = /科技|深色|蓝色|科技蓝/.test(instruction)
			? 'technology'
			: /商务|专业|企业蓝/.test(instruction)
				? 'business'
				: /暖|活力|橙|红/.test(instruction)
					? 'warm'
					: 'editorial'
		return {
			scope: 'visual_theme',
			reason: '修改要求描述了整套演示文稿的视觉风格。',
			nextRequirements: null,
			themePreset,
			generatedTheme: null,
			generatedPageStyle: null,
			targetPageNumber: null,
			pageInstruction: null
		}
	}

	const current = editableRequirements(presentation)
	const topic =
		extractReplacement(instruction, '(?:演示)?主题|标题') ?? current.topic
	const audience =
		extractReplacement(instruction, '目标观众|受众') ?? current.audience
	const exactPageCount = instruction.match(/(?:改成|调整为|设为)\s*(\d+)\s*页/)
	let pageCount = exactPageCount ? Number(exactPageCount[1]) : current.pageCount
	if (/增加一页/.test(instruction)) pageCount += 1
	if (/减少一页/.test(instruction)) pageCount -= 1
	pageCount = Math.min(12, Math.max(3, pageCount))

	return {
		scope: 'global_content',
		reason: '修改要求会影响整份演示文稿的主题、受众、页数或内容方向。',
		nextRequirements: {
			topic,
			audience,
			pageCount,
			additionalRequirements: appendRequirement(
				current.additionalRequirements,
				instruction
			)
		},
		themePreset: null,
		generatedTheme: null,
		generatedPageStyle: null,
		targetPageNumber: null,
		pageInstruction: null
	}
}

const replaySlideTemplates = [
	{
		title: '为什么现在需要可靠的 Agent 工作流',
		purpose: '从长任务失败、人工确认和服务中断三个问题切入。',
		keyPoints: ['模型调用会失败', '业务任务会持续很久', '关键节点需要人工确认']
	},
	{
		title: '从一次调用升级为持久化执行',
		purpose: '说明 Checkpoint 如何保存工作流进度。',
		keyPoints: ['Node 完成后保存状态', '服务重启后恢复 Thread', '避免重复执行已完成步骤']
	},
	{
		title: '页面任务的部分成功与局部重做',
		purpose: '展示页面级任务如何独立记录结果。',
		keyPoints: ['成功页面继续保留', '失败页面单独续做', '单页修改产生新 Revision']
	},
	{
		title: 'Human-in-the-Loop 风险控制',
		purpose: '说明生成内容怎样经过人工审核后继续。',
		keyPoints: ['大纲生成后暂停', '批准、修改与拒绝', '过期版本不能推动流程']
	},
	{
		title: '版本一致性与最终交付',
		purpose: '展示导出前的版本与完整性校验。',
		keyPoints: ['只使用当前大纲页面', '检查最新页面产物', '导出可编辑 PPTX']
	},
	{
		title: '企业落地建议',
		purpose: '给出从课程案例走向真实系统的扩展方向。',
		keyPoints: ['增加模板与品牌资产', '接入对象存储', '补充权限、审计与成本预算']
	}
]

/** 课程 Replay Provider：只替代模型内容，其他链路全部真实执行。 */
class ReplayPresentationProvider implements ModelProvider {
	readonly mode = 'replay' as const

	async planChange(input: {
		instruction: string
		presentation: Presentation
	}): Promise<PresentationChangePlan> {
		return replayChangePlan(input.instruction, input.presentation)
	}

	async generateOutline(input: {
		requirements: PresentationRequirements
		version: number
		previousOutline: OutlineVersion | null
		feedback: string | null
	}): Promise<OutlineDraft> {
		const slides = Array.from({ length: input.requirements.pageCount }, (_, index) => {
			const template = replaySlideTemplates[index % replaySlideTemplates.length]
			if (input.feedback?.includes('成本') && index === 2) {
				return {
					title: '实施成本与资源投入',
					purpose: '响应修改要求，说明项目落地所需的人力与系统资源。',
					keyPoints: ['模型调用与基础设施成本', '研发和运营投入', '分阶段控制实施范围']
				}
			}
			if (input.version > 1 && index === Math.min(3, input.requirements.pageCount - 1)) {
				return {
					title: '企业 Agent 的风险控制与持久化执行',
					purpose: '响应修改意见，补充人工审核、断点恢复和执行边界。',
					keyPoints: [
						'高风险节点进入人工审核',
						'Checkpoint 保存可恢复进度',
						'版本校验阻止旧结果继续流转'
					]
				}
			}
			return template
		})

		return {
			title: input.version > 1
				? `${input.requirements.topic}：企业落地版`
				: input.requirements.topic,
			slides
		}
	}

	async generatePage(input: {
		requirements: PresentationRequirements
		outline: OutlineVersion
		page: PageTask
	}): Promise<GeneratedPage> {
		const outlineSlide = input.outline.slides.find(
			(slide) => slide.pageId === input.page.pageId
		)
		if (!outlineSlide) throw new Error('当前大纲中没有找到页面内容。')

		const bullets = [...outlineSlide.keyPoints]
		if (input.page.changeRequest) {
			bullets[0] = input.page.changeRequest
		}

		return {
			title: outlineSlide.title,
			subtitle: `${input.requirements.audience} · Outline v${input.outline.version}`,
			bullets,
			speakerNote: `本页用于${outlineSlide.purpose}。`
		}
	}
}

/** 使用 DeepSeek 生成真实大纲与页面内容。 */
class DeepSeekPresentationProvider implements ModelProvider {
	readonly mode = 'ai' as const
	private readonly model: ChatDeepSeek

	constructor() {
		if (!process.env.DEEPSEEK_API_KEY) {
			throw new Error('AI 模式需要配置 DEEPSEEK_API_KEY。')
		}
		this.model = new ChatDeepSeek({
			model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
			temperature: 0.2,
			maxRetries: 2,
			timeout: 60_000,
			modelKwargs: { thinking: { type: 'disabled' } }
		})
	}

	async planChange(input: {
		instruction: string
		presentation: Presentation
	}): Promise<PresentationChangePlan> {
		const planner = this.model.withStructuredOutput(PresentationChangePlanSchema, {
			name: 'plan_presentation_change'
		})
		const current = input.presentation
		const result = await planner.invoke([
			{
				role: 'system',
				content: `你负责把用户对演示文稿的自然语言修改要求转换成一个修改计划。
只能选择一种 scope：
- global_content：修改主题、受众、页数或全局内容方向。必须返回完整的 nextRequirements。
- visual_theme：修改整套演示文稿的配色、字体或视觉风格。必须根据用户要求生成完整的 generatedTheme，themePreset 返回 null。
- single_page：修改指定页面的标题、正文或讲解内容。必须返回 targetPageNumber 和 pageInstruction。
- single_page_style：修改指定页面的背景、配色、字体、对齐方式或版式。必须返回 targetPageNumber、pageInstruction 和完整的 generatedPageStyle。
没有使用的字段返回 null。不要虚构用户没有提出的修改。

只要修改要求同时出现具体页码和视觉样式，例如“第二页使用绿色背景”，就必须选择 single_page_style，不能选择 single_page 或 visual_theme。

生成 generatedTheme 时遵守下面的要求：
- name 使用 2～20 个汉字概括视觉风格。
- 字体只能选择 Microsoft YaHei、PingFang SC、DengXian、SimHei。
- 所有颜色都使用不带 # 的 6 位十六进制色值。
- 正文与背景、封面文字与封面背景必须具有清晰的明暗对比。
- layoutStyle 只能选择 side_bar、top_line、corner_block。
- titleAlign 只能选择 left、center。
- density 只能选择 comfortable、compact。
- 应当根据用户描述设计新的配色，不要只是照抄当前主题。

生成 generatedPageStyle 时使用与 generatedTheme 相同的颜色、字体、对比度和枚举约束，但只需要返回单页字段。`
			},
			{
				role: 'user',
				content: JSON.stringify(
					{
						instruction: input.instruction,
						currentRequirements: editableRequirements(current),
						currentTheme: {
							preset: current.theme.preset,
							name: current.theme.name,
							colors: {
								background: current.theme.backgroundColor,
								accent: current.theme.accentColor,
								text: current.theme.textColor
							},
							layoutStyle: current.theme.layoutStyle,
							titleAlign: current.theme.titleAlign,
							density: current.theme.density
						},
						currentPages: current.pages
							.filter((page) => page.outlineVersion === current.currentOutlineVersion)
							.map((page) => ({
								pageNumber: page.order,
								title: page.title,
								status: page.status
							}))
					},
					null,
					2
				)
			}
		])
		const plan = PresentationChangePlanSchema.parse(result)
		if (plan.scope === 'visual_theme' && !plan.generatedTheme) {
			const fallback = replayChangePlan(input.instruction, input.presentation)
			if (fallback.scope !== 'visual_theme') {
				throw new Error('模型没有返回完整的视觉主题配置。')
			}
			return {
				...fallback,
				reason: '模型没有返回完整主题，已使用最接近的安全预设。'
			}
		}
		if (plan.scope === 'single_page_style' && !plan.generatedPageStyle) {
			if (!plan.targetPageNumber) {
				throw new Error('模型没有返回需要修改的页码。')
			}
			return {
				...plan,
				generatedPageStyle: replayPageStyle(input.instruction),
				reason: '模型没有返回完整单页样式，已使用安全样式补全。'
			}
		}
		return plan
	}

	async generateOutline(input: {
		requirements: PresentationRequirements
		version: number
		previousOutline: OutlineVersion | null
		feedback: string | null
	}): Promise<OutlineDraft> {
		const generator = this.model.withStructuredOutput(OutlineDraftSchema, {
			name: 'generate_presentation_outline'
		})
		const result = await generator.invoke([
			{
				role: 'system',
				content:
					'你是企业演示文稿内容策划。根据资料生成结构清晰、每页职责不同的大纲。只使用输入中的事实，不要虚构数据。'
			},
			{
				role: 'user',
				content: JSON.stringify(input, null, 2)
			}
		])

		if (result.slides.length !== input.requirements.pageCount) {
			throw new Error(
				`模型返回 ${result.slides.length} 页，但任务要求 ${input.requirements.pageCount} 页。`
			)
		}
		return result
	}

	async generatePage(input: {
		requirements: PresentationRequirements
		outline: OutlineVersion
		page: PageTask
	}): Promise<GeneratedPage> {
		const generator = this.model.withStructuredOutput(GeneratedPageSchema, {
			name: 'generate_presentation_page'
		})
		return generator.invoke([
			{
				role: 'system',
				content:
					'你是企业演示文稿编辑。只生成当前页，内容必须符合已批准大纲和参考资料。bullet 要简洁，不要写无法核验的数据。'
			},
			{
				role: 'user',
				content: JSON.stringify(input, null, 2)
			}
		])
	}
}

/** 根据 MODEL_MODE 选择 Replay 或真实模型，业务工作流不感知具体实现。 */
@Injectable()
export class PresentationModelService {
	private readonly replayProvider = new ReplayPresentationProvider()
	private aiProvider: DeepSeekPresentationProvider | null = null

	/** 根据当前任务保存的模式选择 Provider。 */
	getProvider(mode: 'replay' | 'ai'): ModelProvider {
		if (mode === 'replay') return this.replayProvider
		this.aiProvider ??= new DeepSeekPresentationProvider()
		return this.aiProvider
	}

	get aiAvailable(): boolean {
		return Boolean(process.env.DEEPSEEK_API_KEY)
	}
}
