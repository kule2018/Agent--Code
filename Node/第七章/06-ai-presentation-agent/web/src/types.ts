export type PresentationStatus =
	| 'creating_outline'
	| 'waiting_review'
	| 'generating_pages'
	| 'partially_completed'
	| 'completed'
	| 'rejected'
	| 'exported'

export interface OutlineSlide {
	pageId: string
	order: number
	title: string
	purpose: string
	keyPoints: string[]
}

export interface OutlineVersion {
	version: number
	status: 'pending_review' | 'approved' | 'superseded' | 'rejected'
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

export interface GeneratedPageStyle {
	headFontFace: string
	bodyFontFace: string
	backgroundColor: string
	accentColor: string
	textColor: string
	mutedColor: string
	layoutStyle: 'side_bar' | 'top_line' | 'corner_block'
	titleAlign: 'left' | 'center'
	density: 'comfortable' | 'compact'
}

export interface PageStyleOverride extends GeneratedPageStyle {
	revision: number
	instruction: string
}

export interface PageTask {
	pageId: string
	order: number
	title: string
	purpose: string
	outlineVersion: number
	pageRevision: number
	status: 'pending' | 'generating' | 'completed' | 'failed' | 'stale'
	attempts: number
	lastError: string | null
	changeRequest: string | null
	styleOverride: PageStyleOverride | null
	currentArtifactId: string | null
	artifacts: PageArtifact[]
}

export interface TimelineEvent {
	id: string
	type: string
	message: string
	createdAt: string
}

export interface PresentationTheme {
	preset: 'editorial' | 'technology' | 'business' | 'warm' | 'custom'
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

export type GeneratedPresentationTheme = Omit<
	PresentationTheme,
	'preset' | 'revision' | 'instruction'
>

export interface PresentationChangePlan {
	scope:
		| 'global_content'
		| 'visual_theme'
		| 'single_page'
		| 'single_page_style'
	reason: string
	nextRequirements: {
		topic: string
		audience: string
		pageCount: number
		additionalRequirements: string
	} | null
	themePreset: Exclude<PresentationTheme['preset'], 'custom'> | null
	generatedTheme: GeneratedPresentationTheme | null
	generatedPageStyle: GeneratedPageStyle | null
	targetPageNumber: number | null
	pageInstruction: string | null
}

export interface Presentation {
	id: string
	threadId: string
	modelMode: 'replay' | 'ai'
	status: PresentationStatus
	requirements: {
		topic: string
		audience: string
		pageCount: number
		additionalRequirements: string
		sourceText: string
		sourceName: string
	}
	theme: PresentationTheme
	outlines: OutlineVersion[]
	currentOutlineVersion: number | null
	pages: PageTask[]
	timeline: TimelineEvent[]
	exportRecord: {
		fileName: string
		filePath: string
		outlineVersion: number
		pageArtifactIds: string[]
		createdAt: string
	} | null
	createdAt: string
	updatedAt: string
}

export interface CreatePresentationInput {
	modelMode: 'replay' | 'ai'
	topic: string
	audience: string
	pageCount: number
	additionalRequirements: string
	sourceText: string
	sourceName: string
}

export interface ApplyChangeResult {
	presentation: Presentation
	plan: PresentationChangePlan
}
