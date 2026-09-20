import * as z from 'zod'

export const EditableRequirementsSchema = z.object({
	topic: z.string().trim().min(2).max(120),
	audience: z.string().trim().min(2).max(120),
	pageCount: z.number().int().min(3).max(12),
	additionalRequirements: z.string().trim().max(1000).default('')
})

export const ThemePresetSchema = z.enum([
	'editorial',
	'technology',
	'business',
	'warm'
])

export const ThemeColorSchema = z
	.string()
	.trim()
	.regex(/^[0-9a-fA-F]{6}$/, '颜色必须是 6 位十六进制色值')
	.transform((value) => value.toUpperCase())

export const ThemeFontSchema = z.enum([
	'Microsoft YaHei',
	'PingFang SC',
	'DengXian',
	'SimHei'
])

export const GeneratedPresentationThemeSchema = z.object({
	name: z.string().trim().min(2).max(20),
	headFontFace: ThemeFontSchema,
	bodyFontFace: ThemeFontSchema,
	coverBackgroundColor: ThemeColorSchema,
	backgroundColor: ThemeColorSchema,
	accentColor: ThemeColorSchema,
	coverTextColor: ThemeColorSchema,
	textColor: ThemeColorSchema,
	coverMutedColor: ThemeColorSchema,
	mutedColor: ThemeColorSchema,
	layoutStyle: z.enum(['side_bar', 'top_line', 'corner_block']),
	titleAlign: z.enum(['left', 'center']),
	density: z.enum(['comfortable', 'compact'])
})

export const GeneratedPageStyleSchema = z.object({
	headFontFace: ThemeFontSchema,
	bodyFontFace: ThemeFontSchema,
	backgroundColor: ThemeColorSchema,
	accentColor: ThemeColorSchema,
	textColor: ThemeColorSchema,
	mutedColor: ThemeColorSchema,
	layoutStyle: z.enum(['side_bar', 'top_line', 'corner_block']),
	titleAlign: z.enum(['left', 'center']),
	density: z.enum(['comfortable', 'compact'])
})

export const CreatePresentationSchema = z.object({
	modelMode: z.enum(['replay', 'ai']).default('replay'),
	...EditableRequirementsSchema.shape,
	sourceText: z.string().trim().min(20).max(60_000),
	sourceName: z.string().trim().min(1).max(160).default('粘贴内容')
})

export const ReviewOutlineSchema = z.object({
	decision: z.enum(['approve', 'revise', 'reject']),
	outlineVersion: z.number().int().positive(),
	feedback: z.string().trim().max(1000).default('')
})

export const RevisePageSchema = z.object({
	changeRequest: z.string().trim().min(2).max(1000)
})

export const ApplyChangeSchema = z.object({
	instruction: z.string().trim().min(2).max(1000)
})

export type CreatePresentationInput = z.infer<typeof CreatePresentationSchema>
export type EditablePresentationRequirements = z.infer<
	typeof EditableRequirementsSchema
>
export type ReviewOutlineInput = z.infer<typeof ReviewOutlineSchema>
export type RevisePageInput = z.infer<typeof RevisePageSchema>
export type ApplyChangeInput = z.infer<typeof ApplyChangeSchema>
export type ThemePreset = z.infer<typeof ThemePresetSchema>
export type GeneratedPresentationTheme = z.infer<
	typeof GeneratedPresentationThemeSchema
>
export type GeneratedPageStyle = z.infer<typeof GeneratedPageStyleSchema>

export type PresentationStatus =
	| 'creating_outline'
	| 'waiting_review'
	| 'generating_pages'
	| 'partially_completed'
	| 'completed'
	| 'rejected'
	| 'exported'

export type OutlineStatus =
	| 'pending_review'
	| 'approved'
	| 'superseded'
	| 'rejected'

export type PageStatus =
	| 'pending'
	| 'generating'
	| 'completed'
	| 'failed'
	| 'stale'

export type PresentationRequirements = Omit<CreatePresentationInput, 'modelMode'>

export interface PresentationTheme {
	preset: ThemePreset | 'custom'
	name: string
	revision: number
	instruction: string | null
	headFontFace: string
	bodyFontFace: string
	coverBackgroundColor: string
	backgroundColor: string
	accentColor: string
	coverTextColor: string
	textColor: string
	coverMutedColor: string
	mutedColor: string
	layoutStyle: 'side_bar' | 'top_line' | 'corner_block'
	titleAlign: 'left' | 'center'
	density: 'comfortable' | 'compact'
}

export interface PresentationChangePlan {
	scope:
		| 'global_content'
		| 'visual_theme'
		| 'single_page'
		| 'single_page_style'
	reason: string
	nextRequirements: EditablePresentationRequirements | null
	themePreset: ThemePreset | null
	generatedTheme: GeneratedPresentationTheme | null
	generatedPageStyle: GeneratedPageStyle | null
	targetPageNumber: number | null
	pageInstruction: string | null
}

export interface PageStyleOverride extends GeneratedPageStyle {
	revision: number
	instruction: string
}

export interface OutlineSlide {
	pageId: string
	order: number
	title: string
	purpose: string
	keyPoints: string[]
}

export interface OutlineVersion {
	version: number
	status: OutlineStatus
	title: string
	slides: OutlineSlide[]
	feedback: string | null
	createdAt: string
	approvedAt: string | null
}

export interface PageArtifact {
	artifactId: string
	outlineVersion: number
	pageRevision: number
	title: string
	subtitle: string
	bullets: string[]
	speakerNote: string
	createdAt: string
}

export interface PageTask {
	pageId: string
	order: number
	title: string
	purpose: string
	outlineVersion: number
	pageRevision: number
	status: PageStatus
	attempts: number
	lastError: string | null
	changeRequest: string | null
	styleOverride: PageStyleOverride | null
	currentArtifactId: string | null
	artifacts: PageArtifact[]
}

export interface TimelineEvent {
	id: string
	type:
		| 'task_created'
		| 'outline_generated'
		| 'outline_revised'
		| 'outline_approved'
		| 'task_rejected'
		| 'page_started'
		| 'page_completed'
		| 'page_failed'
		| 'page_revision_requested'
		| 'page_style_updated'
		| 'requirements_updated'
		| 'theme_updated'
		| 'export_completed'
	message: string
	createdAt: string
}

export interface ExportRecord {
	fileName: string
	filePath: string
	outlineVersion: number
	pageArtifactIds: string[]
	createdAt: string
}

export interface Presentation {
	id: string
	threadId: string
	modelMode: 'replay' | 'ai'
	status: PresentationStatus
	requirements: PresentationRequirements
	theme: PresentationTheme
	outlines: OutlineVersion[]
	currentOutlineVersion: number | null
	pages: PageTask[]
	timeline: TimelineEvent[]
	exportRecord: ExportRecord | null
	createdAt: string
	updatedAt: string
}

export interface OutlineDraft {
	title: string
	slides: Array<Omit<OutlineSlide, 'pageId' | 'order'>>
}

export interface GeneratedPage {
	title: string
	subtitle: string
	bullets: string[]
	speakerNote: string
}

export interface ModelProvider {
	readonly mode: 'replay' | 'ai'
	planChange(input: {
		instruction: string
		presentation: Presentation
	}): Promise<PresentationChangePlan>
	generateOutline(input: {
		requirements: PresentationRequirements
		version: number
		previousOutline: OutlineVersion | null
		feedback: string | null
	}): Promise<OutlineDraft>
	generatePage(input: {
		requirements: PresentationRequirements
		outline: OutlineVersion
		page: PageTask
	}): Promise<GeneratedPage>
}
