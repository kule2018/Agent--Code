import { describe, expect, it } from 'vitest'
import { PresentationAggregate } from './presentation.aggregate.js'
import type { GeneratedPage, OutlineDraft } from './presentation.types.js'

const input = {
	modelMode: 'replay' as const,
	topic: '企业 Agent 发布方案',
	audience: '技术负责人',
	pageCount: 3,
	additionalRequirements: '',
	sourceText: '这是一份长度足够的企业 Agent 课程资料，用于测试大纲和页面状态。',
	sourceName: 'source.md'
}

const draft: OutlineDraft = {
	title: '企业 Agent 发布方案',
	slides: [1, 2, 3].map((number) => ({
		title: `第 ${number} 页`,
		purpose: `解释主题 ${number}`,
		keyPoints: [`重点 ${number}-1`, `重点 ${number}-2`]
	}))
}

const pageContent: GeneratedPage = {
	title: '页面标题',
	subtitle: '页面副标题',
	bullets: ['要点一', '要点二'],
	speakerNote: '讲解备注'
}

function createApprovedAggregate() {
	const aggregate = PresentationAggregate.create(input)
	aggregate.addOutline(draft, null)
	aggregate.approveOutline(1)
	aggregate.ensurePageTasks()
	return aggregate
}

describe('PresentationAggregate', () => {
	it('只允许审核当前大纲版本', () => {
		const aggregate = PresentationAggregate.create(input)
		expect(aggregate.toJSON().modelMode).toBe('replay')
		aggregate.addOutline(draft, null)
		aggregate.addOutline(
			{ ...draft, title: '企业 Agent 发布方案 v2' },
			'补充风险控制'
		)

		expect(() => aggregate.approveOutline(1)).toThrow('已经过期')
		aggregate.approveOutline(2)
		expect(aggregate.currentOutline?.status).toBe('approved')
	})

	it('页面失败不会丢失其他页面的成功结果', () => {
		const aggregate = createApprovedAggregate()
		aggregate.startPage('page-1')
		aggregate.completePage('page-1', pageContent)
		aggregate.startPage('page-2')
		aggregate.failPage('page-2', '生成服务不可用')

		const [page1, page2] = aggregate.getCurrentPages()
		expect(page1.status).toBe('completed')
		expect(page2.status).toBe('failed')
		expect(aggregate.toJSON().status).toBe('partially_completed')
		expect(aggregate.getPendingPageIds()).toContain('page-2')
	})

	it('单页修改只增加目标页面的 Revision', () => {
		const aggregate = createApprovedAggregate()
		for (const page of aggregate.getCurrentPages()) {
			aggregate.startPage(page.pageId)
			aggregate.completePage(page.pageId, {
				...pageContent,
				title: page.title
			})
		}

		aggregate.requestPageRevision('page-2', '突出业务收益')
		const pages = aggregate.getCurrentPages()
		expect(pages.map((page) => page.pageRevision)).toEqual([1, 2, 1])
		expect(pages[1].status).toBe('pending')
		expect(() => aggregate.assertExportable()).toThrow('page-2')
	})

	it('只有当前版本页面全部完成后才允许导出', () => {
		const aggregate = createApprovedAggregate()
		for (const page of aggregate.getCurrentPages()) {
			aggregate.startPage(page.pageId)
			aggregate.completePage(page.pageId, pageContent)
		}
		expect(aggregate.assertExportable()).toHaveLength(3)
	})

	it('全局制作要求变化后生成新大纲并让旧页面失效', () => {
		const aggregate = createApprovedAggregate()
		aggregate.updateRequirements(
			{
				topic: '企业 Agent 落地方案',
				audience: input.audience,
				pageCount: 3,
				additionalRequirements: '增加实施成本说明'
			},
			'修改演示主题并增加成本说明'
		)
		aggregate.addOutline(
			{ ...draft, title: '企业 Agent 落地方案' },
			'修改演示主题并增加成本说明'
		)

		const value = aggregate.toJSON()
		expect(value.requirements.topic).toBe('企业 Agent 落地方案')
		expect(value.currentOutlineVersion).toBe(2)
		expect(value.pages.every((page) => page.status === 'stale')).toBe(true)
		expect(value.status).toBe('waiting_review')
	})

	it('视觉主题变化不会重做页面，但会使旧导出失效', () => {
		const aggregate = createApprovedAggregate()
		for (const page of aggregate.getCurrentPages()) {
			aggregate.startPage(page.pageId)
			aggregate.completePage(page.pageId, pageContent)
		}
		aggregate.recordExport({
			fileName: 'demo.pptx',
			filePath: '/tmp/demo.pptx',
			outlineVersion: 1,
			pageArtifactIds: aggregate
				.getCurrentPages()
				.map((page) => page.currentArtifactId!),
			createdAt: new Date().toISOString()
		})

		aggregate.changeTheme('technology', '整体改成深色科技风')
		const value = aggregate.toJSON()
		expect(value.theme.preset).toBe('technology')
		expect(value.theme.revision).toBe(2)
		expect(value.pages.every((page) => page.status === 'completed')).toBe(true)
		expect(value.exportRecord).toBeNull()
		expect(value.status).toBe('completed')
	})

	it('可以保存 AI 生成的主题，并自动修正不可读的文字颜色', () => {
		const aggregate = createApprovedAggregate()
		aggregate.changeTheme(
			{
				name: '森林商务',
				headFontFace: 'Microsoft YaHei',
				bodyFontFace: 'Microsoft YaHei',
				coverBackgroundColor: '12372A',
				backgroundColor: 'F4F1E8',
				accentColor: 'C6A15B',
				coverTextColor: 'FFFFFF',
				textColor: 'F4F1E8',
				coverMutedColor: 'A8C8B8',
				mutedColor: 'F4F1E8',
				layoutStyle: 'corner_block',
				titleAlign: 'center',
				density: 'compact'
			},
			'使用墨绿色和金色设计沉稳的高端商务风'
		)

		const theme = aggregate.toJSON().theme
		expect(theme.preset).toBe('custom')
		expect(theme.name).toBe('森林商务')
		expect(theme.layoutStyle).toBe('corner_block')
		expect(theme.titleAlign).toBe('center')
		expect(theme.textColor).not.toBe(theme.backgroundColor)
		expect(theme.mutedColor).not.toBe(theme.backgroundColor)
	})

	it('单页样式只覆盖目标页面，不会重新生成页面正文', () => {
		const aggregate = createApprovedAggregate()
		for (const page of aggregate.getCurrentPages()) {
			aggregate.startPage(page.pageId)
			aggregate.completePage(page.pageId, {
				...pageContent,
				title: page.title
			})
		}
		aggregate.recordExport({
			fileName: 'demo.pptx',
			filePath: '/tmp/demo.pptx',
			outlineVersion: 1,
			pageArtifactIds: aggregate
				.getCurrentPages()
				.map((page) => page.currentArtifactId!),
			createdAt: new Date().toISOString()
		})

		aggregate.changePageStyle(
			'page-2',
			{
				headFontFace: 'Microsoft YaHei',
				bodyFontFace: 'Microsoft YaHei',
				backgroundColor: '12372A',
				accentColor: '8DBF67',
				textColor: 'FFFFFF',
				mutedColor: 'B8D4C4',
				layoutStyle: 'side_bar',
				titleAlign: 'left',
				density: 'comfortable'
			},
			'第二页使用绿色背景'
		)

		const value = aggregate.toJSON()
		expect(value.pages[0].styleOverride).toBeNull()
		expect(value.pages[1].styleOverride?.backgroundColor).toBe('12372A')
		expect(value.pages[1].styleOverride?.revision).toBe(1)
		expect(value.pages.map((page) => page.pageRevision)).toEqual([1, 1, 1])
		expect(value.exportRecord).toBeNull()
		expect(value.status).toBe('completed')
	})
})
