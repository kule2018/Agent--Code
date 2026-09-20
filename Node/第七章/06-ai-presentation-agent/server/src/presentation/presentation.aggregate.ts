import { randomUUID } from 'node:crypto'
import type {
	CreatePresentationInput,
	EditablePresentationRequirements,
	ExportRecord,
	GeneratedPageStyle,
	GeneratedPresentationTheme,
	GeneratedPage,
	OutlineDraft,
	OutlineVersion,
	PageTask,
	Presentation,
	ThemePreset,
	TimelineEvent
} from './presentation.types.js'
import {
	createGeneratedPresentationTheme,
	createPageStyleOverride,
	createPresentationTheme,
	restorePresentationTheme
} from './presentation-theme.js'

/** 演示文稿领域对象，集中维护版本、审核、页面和导出规则。 */
export class PresentationAggregate {
	private constructor(private readonly value: Presentation) {}

	static create(input: CreatePresentationInput): PresentationAggregate {
		const now = new Date().toISOString()
		const id = `PRES-${randomUUID().slice(0, 8).toUpperCase()}`
		const { modelMode, ...requirements } = input
		const presentation: Presentation = {
			id,
			threadId: `presentation:${id}`,
			modelMode,
			status: 'creating_outline',
			requirements,
			theme: createPresentationTheme(),
			outlines: [],
			currentOutlineVersion: null,
			pages: [],
			timeline: [],
			exportRecord: null,
			createdAt: now,
			updatedAt: now
		}
		const aggregate = new PresentationAggregate(presentation)
		aggregate.event('task_created', `创建演示文稿任务：${input.topic}`)
		return aggregate
	}

	static restore(value: Presentation): PresentationAggregate {
		return new PresentationAggregate({
			...structuredClone(value),
			// 兼容切换功能加入以前已经创建的 Replay 任务。
			modelMode: value.modelMode ?? 'replay',
			// 兼容视觉主题和布局参数加入以前已经创建的任务。
			theme: restorePresentationTheme(value.theme),
			pages: value.pages.map((page) => ({
				...page,
				styleOverride: page.styleOverride ?? null
			}))
		})
	}

	/** 单页样式覆盖全局主题，不重新生成该页正文。 */
	changePageStyle(
		pageId: string,
		style: GeneratedPageStyle,
		instruction: string
	): void {
		const page = this.getPage(pageId)
		const revision = (page.styleOverride?.revision ?? 0) + 1
		page.styleOverride = createPageStyleOverride(
			style,
			revision,
			instruction
		)
		this.value.exportRecord = null
		if (this.value.status === 'exported') this.value.status = 'completed'
		this.event(
			'page_style_updated',
			`第 ${page.order} 页视觉样式已更新为 v${revision}`
		)
	}

	toJSON(): Presentation {
		return structuredClone(this.value)
	}

	get currentOutline(): OutlineVersion | null {
		return (
			this.value.outlines.find(
				(outline) => outline.version === this.value.currentOutlineVersion
			) ?? null
		)
	}

	/** 更新全局制作要求；新大纲生成后，旧页面会由 addOutline 统一失效。 */
	updateRequirements(
		next: EditablePresentationRequirements,
		instruction: string
	): void {
		this.value.requirements = {
			...this.value.requirements,
			...next
		}
		this.value.exportRecord = null
		this.event('requirements_updated', `已更新制作要求：${instruction}`)
	}

	/** 切换视觉主题只影响展示与导出，不重复生成大纲和页面正文。 */
	changeTheme(
		theme: ThemePreset | GeneratedPresentationTheme,
		instruction: string
	): void {
		const revision = (this.value.theme?.revision ?? 0) + 1
		this.value.theme =
			typeof theme === 'string'
				? createPresentationTheme(theme, revision, instruction)
				: createGeneratedPresentationTheme(theme, revision, instruction)
		this.value.exportRecord = null
		if (this.value.status === 'exported') this.value.status = 'completed'
		this.event(
			'theme_updated',
			`视觉主题已更新为“${this.value.theme.name}”`
		)
	}

	/** 保存模型生成的大纲，并让上一版大纲和页面失效。 */
	addOutline(draft: OutlineDraft, feedback: string | null): OutlineVersion {
		const version = (this.value.currentOutlineVersion ?? 0) + 1

		for (const outline of this.value.outlines) {
			if (outline.status === 'pending_review' || outline.status === 'approved') {
				outline.status = 'superseded'
			}
		}

		for (const page of this.value.pages) {
			if (page.status !== 'stale') {
				page.status = 'stale'
				page.lastError = `页面属于 Outline v${page.outlineVersion}`
			}
		}

		const outline: OutlineVersion = {
			version,
			status: 'pending_review',
			title: draft.title,
			slides: draft.slides.map((slide, index) => ({
				...slide,
				pageId: `page-${index + 1}`,
				order: index + 1
			})),
			feedback,
			createdAt: new Date().toISOString(),
			approvedAt: null
		}

		this.value.outlines.push(outline)
		this.value.currentOutlineVersion = version
		this.value.status = 'waiting_review'
		this.value.exportRecord = null
		this.event(
			version === 1 ? 'outline_generated' : 'outline_revised',
			`Outline v${version} 已生成，等待审核`
		)
		return structuredClone(outline)
	}

	/** 只允许审核当前仍在等待确认的大纲版本。 */
	assertReviewable(version: number): OutlineVersion {
		const outline = this.currentOutline
		if (!outline || outline.version !== version) {
			throw new Error(`Outline v${version} 已经过期，请审核当前版本。`)
		}
		if (outline.status !== 'pending_review') {
			throw new Error(`Outline v${version} 当前不能审核。`)
		}
		return outline
	}

	approveOutline(version: number): void {
		const outline = this.assertReviewable(version)
		outline.status = 'approved'
		outline.approvedAt = new Date().toISOString()
		this.value.status = 'generating_pages'
		this.event('outline_approved', `Outline v${version} 已批准`)
	}

	rejectOutline(version: number, feedback: string): void {
		const outline = this.assertReviewable(version)
		outline.status = 'rejected'
		outline.feedback = feedback || null
		this.value.status = 'rejected'
		this.event('task_rejected', `Outline v${version} 被拒绝，任务结束`)
	}

	/** 根据当前已批准大纲建立页面任务，同一页面只创建一次。 */
	ensurePageTasks(): PageTask[] {
		const outline = this.currentOutline
		if (!outline || outline.status !== 'approved') {
			throw new Error('只有通过审核的大纲才能创建页面任务。')
		}

		const existing = this.value.pages.filter(
			(page) => page.outlineVersion === outline.version
		)
		if (existing.length > 0) return structuredClone(existing)

		const pages: PageTask[] = outline.slides.map((slide) => ({
			pageId: slide.pageId,
			order: slide.order,
			title: slide.title,
			purpose: slide.purpose,
			outlineVersion: outline.version,
			pageRevision: 1,
			status: 'pending',
			attempts: 0,
			lastError: null,
			changeRequest: null,
			styleOverride: null,
			currentArtifactId: null,
			artifacts: []
		}))
		this.value.pages.push(...pages)
		this.value.status = 'generating_pages'
		this.touch()
		return structuredClone(pages)
	}

	getCurrentPages(): PageTask[] {
		const version = this.value.currentOutlineVersion
		return this.value.pages
			.filter((page) => page.outlineVersion === version)
			.sort((a, b) => a.order - b.order)
	}

	getPage(pageId: string): PageTask {
		const page = this.getCurrentPages().find((item) => item.pageId === pageId)
		if (!page) throw new Error(`没有找到当前版本页面：${pageId}`)
		return page
	}

	startPage(pageId: string): PageTask {
		const page = this.getPage(pageId)
		page.attempts += 1
		page.status = 'generating'
		page.lastError = null
		this.value.status = 'generating_pages'
		this.event('page_started', `开始制作第 ${page.order} 页：${page.title}`)
		return structuredClone(page)
	}

	completePage(pageId: string, content: GeneratedPage): void {
		const page = this.getPage(pageId)
		const artifactId = [
			this.value.id,
			`outline-v${page.outlineVersion}`,
			page.pageId,
			`revision-${page.pageRevision}`
		].join(':')
		const exists = page.artifacts.some(
			(artifact) => artifact.artifactId === artifactId
		)
		if (!exists) {
			page.artifacts.push({
				artifactId,
				outlineVersion: page.outlineVersion,
				pageRevision: page.pageRevision,
				...content,
				createdAt: new Date().toISOString()
			})
		}
		page.currentArtifactId = artifactId
		page.status = 'completed'
		page.lastError = null
		this.event('page_completed', `第 ${page.order} 页制作完成`)
		this.refreshStatus()
	}

	failPage(pageId: string, message: string): void {
		const page = this.getPage(pageId)
		page.status = 'failed'
		page.lastError = message
		this.event('page_failed', `第 ${page.order} 页制作失败：${message}`)
		this.refreshStatus()
	}

	/** 只让目标页面进入新 Revision，其他页面保持不变。 */
	requestPageRevision(pageId: string, changeRequest: string): PageTask {
		const page = this.getPage(pageId)
		if (page.status !== 'completed') {
			throw new Error('只有已经完成的页面才能单独修改。')
		}
		page.pageRevision += 1
		page.status = 'pending'
		page.currentArtifactId = null
		page.lastError = null
		page.changeRequest = changeRequest
		this.value.status = 'generating_pages'
		this.value.exportRecord = null
		this.event(
			'page_revision_requested',
			`第 ${page.order} 页进入 Revision ${page.pageRevision}`
		)
		return structuredClone(page)
	}

	getPendingPageIds(): string[] {
		return this.getCurrentPages()
			.filter((page) => ['pending', 'failed', 'stale'].includes(page.status))
			.map((page) => page.pageId)
	}

	/** 导出前校验当前大纲和每一页的版本、状态与产物指针。 */
	assertExportable(): PageTask[] {
		const outline = this.currentOutline
		if (!outline || outline.status !== 'approved') {
			throw new Error('当前大纲尚未通过审核，不能导出。')
		}
		const pages = this.getCurrentPages()
		if (pages.length !== outline.slides.length) {
			throw new Error('当前大纲的页面任务还没有全部创建。')
		}
		const invalid = pages.filter((page) => {
			const artifact = page.artifacts.find(
				(item) => item.artifactId === page.currentArtifactId
			)
			return (
				page.status !== 'completed' ||
				!artifact ||
				artifact.outlineVersion !== outline.version ||
				artifact.pageRevision !== page.pageRevision
			)
		})
		if (invalid.length > 0) {
			throw new Error(
				`以下页面尚未满足导出条件：${invalid
					.map((page) => `${page.pageId}(${page.status})`)
					.join('、')}`
			)
		}
		return structuredClone(pages)
	}

	recordExport(record: ExportRecord): void {
		this.value.exportRecord = record
		this.value.status = 'exported'
		this.event('export_completed', `已导出 ${record.fileName}`)
	}

	private refreshStatus(): void {
		const pages = this.getCurrentPages()
		const hasIncomplete = pages.some((page) => page.status !== 'completed')
		const hasFailed = pages.some((page) => page.status === 'failed')
		this.value.status = hasIncomplete
			? hasFailed
				? 'partially_completed'
				: 'generating_pages'
			: 'completed'
		this.touch()
	}

	private event(type: TimelineEvent['type'], message: string): void {
		this.value.timeline.push({
			id: randomUUID(),
			type,
			message,
			createdAt: new Date().toISOString()
		})
		this.touch()
	}

	private touch(): void {
		this.value.updatedAt = new Date().toISOString()
	}
}
