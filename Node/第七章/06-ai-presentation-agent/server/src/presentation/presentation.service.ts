import { Inject, Injectable } from '@nestjs/common'
import { access } from 'node:fs/promises'
import { PresentationAggregate } from './presentation.aggregate.js'
import { PresentationGraphService } from './presentation-graph.service.js'
import { PresentationModelService } from './model.service.js'
import { PresentationRepository } from './presentation.repository.js'
import type {
	ApplyChangeInput,
	CreatePresentationInput,
	Presentation,
	PresentationChangePlan,
	ReviewOutlineInput
} from './presentation.types.js'

@Injectable()
export class PresentationService {
	constructor(
		@Inject(PresentationRepository)
		private readonly repository: PresentationRepository,
		@Inject(PresentationGraphService)
		private readonly graph: PresentationGraphService,
		@Inject(PresentationModelService)
		private readonly models: PresentationModelService
	) {}

	async setup(): Promise<void> {
		await this.repository.setup()
	}

	getMeta() {
		return {
			defaultMode: process.env.MODEL_MODE === 'ai' ? 'ai' : 'replay',
			aiAvailable: this.models.aiAvailable,
			model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash'
		}
	}

	// 创建一个新的演示文稿制作任务
	async create(input: CreatePresentationInput): Promise<Presentation> {
		// 根据用户提交的制作需求创建领域聚合根
		// 聚合内部负责初始化演示文稿状态、生成唯一 ID 等业务逻辑
		const aggregate = PresentationAggregate.create(input)

		// 将聚合根当前状态持久化到数据库
		// 保存的是领域对象转换后的普通数据结构，而不是直接保存聚合实例
		await this.repository.save(aggregate.toJSON())

		// 启动对应的 Agent 工作流
		// 后续会根据任务 ID 执行大纲生成、审核等待、页面制作等流程
		await this.graph.start(aggregate.toJSON().id)

		// 返回最新的演示文稿数据
		// 通过查询获取完整状态，避免直接返回创建时的旧数据
		return this.get(aggregate.toJSON().id)
	}

	async list(): Promise<Presentation[]> {
		return this.repository.list()
	}

	async get(id: string): Promise<Presentation> {
		const value = await this.repository.findById(id)
		if (!value) throw new Error(`没有找到演示文稿任务：${id}`)
		return value
	}

	async review(id: string, input: ReviewOutlineInput): Promise<Presentation> {
		await this.graph.review(id, input)
		return this.get(id)
	}

	async continuePages(id: string): Promise<Presentation> {
		await this.graph.continuePages(id)
		return this.get(id)
	}

	async revisePage(
		id: string,
		pageId: string,
		changeRequest: string
	): Promise<Presentation> {
		await this.graph.revisePage(id, pageId, changeRequest)
		return this.get(id)
	}

	/** 解析自然语言要求，并把修改交给对应的领域流程。 */
	async applyChange(
		id: string,
		input: ApplyChangeInput
	): Promise<{ presentation: Presentation; plan: PresentationChangePlan }> {
		const presentation = await this.get(id)
		if (presentation.status === 'rejected') {
			throw new Error('任务已经被拒绝，请重新创建演示文稿。')
		}

		const provider = this.models.getProvider(presentation.modelMode)
		const plan = await provider.planChange({
			instruction: input.instruction,
			presentation
		})

		if (plan.scope === 'global_content') {
			if (!plan.nextRequirements) {
				throw new Error('修改计划缺少新的全局制作要求。')
			}
			await this.graph.reviseRequirements(
				id,
				plan.nextRequirements,
				input.instruction
			)
		}

		if (plan.scope === 'visual_theme') {
			const theme = plan.generatedTheme ?? plan.themePreset
			if (!theme) throw new Error('修改计划缺少视觉主题。')
			const aggregate = PresentationAggregate.restore(presentation)
			aggregate.changeTheme(theme, input.instruction)
			await this.repository.save(aggregate.toJSON())
		}

		if (plan.scope === 'single_page') {
			if (!plan.targetPageNumber || !plan.pageInstruction) {
				throw new Error('修改计划缺少目标页码或单页修改要求。')
			}
			const page = presentation.pages.find(
				(item) =>
					item.outlineVersion === presentation.currentOutlineVersion &&
					item.order === plan.targetPageNumber
			)
			if (!page) {
				throw new Error(`当前版本中没有第 ${plan.targetPageNumber} 页。`)
			}
			await this.graph.revisePage(id, page.pageId, plan.pageInstruction)
		}

		if (plan.scope === 'single_page_style') {
			if (!plan.targetPageNumber || !plan.generatedPageStyle) {
				throw new Error('修改计划缺少目标页码或单页样式。')
			}
			const page = presentation.pages.find(
				(item) =>
					item.outlineVersion === presentation.currentOutlineVersion &&
					item.order === plan.targetPageNumber
			)
			if (!page) {
				throw new Error(`当前版本中没有第 ${plan.targetPageNumber} 页。`)
			}
			const aggregate = PresentationAggregate.restore(presentation)
			aggregate.changePageStyle(
				page.pageId,
				plan.generatedPageStyle,
				input.instruction
			)
			await this.repository.save(aggregate.toJSON())
		}

		return { presentation: await this.get(id), plan }
	}

	async export(id: string): Promise<Presentation> {
		await this.graph.export(id)
		return this.get(id)
	}

	async getDownload(id: string): Promise<{ path: string; fileName: string }> {
		const presentation = await this.get(id)
		if (!presentation.exportRecord) throw new Error('当前任务还没有导出文件。')
		await access(presentation.exportRecord.filePath)
		return {
			path: presentation.exportRecord.filePath,
			fileName: presentation.exportRecord.fileName
		}
	}
}
