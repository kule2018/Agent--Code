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

	/**
	 * 解析用户的自然语言修改要求，并根据修改范围交给对应的领域流程处理。
	 *
	 * 主要负责：
	 * 1. 获取当前演示文稿状态。
	 * 2. 调用模型分析用户意图，生成结构化修改计划。
	 * 3. 根据修改范围执行不同的业务操作：
	 *    - global_content：修改整体制作要求，重新生成大纲。
	 *    - visual_theme：修改整体视觉主题。
	 *    - single_page：修改指定页面内容。
	 *    - single_page_style：修改指定页面样式。
	 * 4. 返回最新演示文稿状态和本次修改计划。
	 */
	async applyChange(
		id: string,
		input: ApplyChangeInput
	): Promise<{ presentation: Presentation; plan: PresentationChangePlan }> {
		// 获取当前演示文稿状态
		const presentation = await this.get(id)

		// 已被拒绝的任务不能继续修改
		if (presentation.status === 'rejected') {
			throw new Error('任务已经被拒绝，请重新创建演示文稿。')
		}

		// 根据当前模型模式获取对应模型服务
		const provider = this.models.getProvider(presentation.modelMode)

		// 让模型理解用户修改意图，并转换成结构化修改计划
		const plan = await provider.planChange({
			instruction: input.instruction,
			presentation
		})

		/**
		 * 修改范围：整体内容调整。
		 *
		 * 例如：
		 * "把这份 PPT 改成面向投资人的版本"
		 *
		 * 需要更新制作要求，并重新进入大纲生成流程。
		 */
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

		/**
		 * 修改范围：整体视觉主题调整。
		 *
		 * 例如：
		 * "整体换成科技感蓝色主题"
		 *
		 * 直接修改领域模型中的主题配置。
		 */
		if (plan.scope === 'visual_theme') {
			const theme = plan.generatedTheme ?? plan.themePreset

			if (!theme) {
				throw new Error('修改计划缺少视觉主题。')
			}

			// 恢复聚合根，通过领域方法修改主题
			const aggregate = PresentationAggregate.restore(presentation)

			aggregate.changeTheme(theme, input.instruction)

			// 保存修改后的领域状态
			await this.repository.save(aggregate.toJSON())
		}

		/**
		 * 修改范围：单个页面内容调整。
		 *
		 * 例如：
		 * "第三页的数据分析部分重新写一下"
		 *
		 * 找到目标页面后，交给工作流重新生成。
		 */
		if (plan.scope === 'single_page') {
			if (!plan.targetPageNumber || !plan.pageInstruction) {
				throw new Error('修改计划缺少目标页码或单页修改要求。')
			}

			// 根据当前大纲版本和页码定位目标页面
			const page = presentation.pages.find(
				(item) =>
					item.outlineVersion === presentation.currentOutlineVersion &&
					item.order === plan.targetPageNumber
			)

			if (!page) {
				throw new Error(`当前版本中没有第 ${plan.targetPageNumber} 页。`)
			}

			// 触发页面重新生成流程
			await this.graph.revisePage(id, page.pageId, plan.pageInstruction)
		}

		/**
		 * 修改范围：单个页面样式调整。
		 *
		 * 例如：
		 * "第三页布局改成更简洁的风格"
		 *
		 * 只修改页面视觉配置，不重新生成页面内容。
		 */
		if (plan.scope === 'single_page_style') {
			if (!plan.targetPageNumber || !plan.generatedPageStyle) {
				throw new Error('修改计划缺少目标页码或单页样式。')
			}

			// 定位目标页面
			const page = presentation.pages.find(
				(item) =>
					item.outlineVersion === presentation.currentOutlineVersion &&
					item.order === plan.targetPageNumber
			)

			if (!page) {
				throw new Error(`当前版本中没有第 ${plan.targetPageNumber} 页。`)
			}

			// 恢复聚合根，通过领域方法修改页面样式
			const aggregate = PresentationAggregate.restore(presentation)

			aggregate.changePageStyle(
				page.pageId,
				plan.generatedPageStyle,
				input.instruction
			)

			// 保存修改后的页面状态
			await this.repository.save(aggregate.toJSON())
		}

		// 返回最新演示文稿状态，以及模型生成的修改计划
		return {
			presentation: await this.get(id),
			plan
		}
	}

	async export(id: string): Promise<Presentation> {
		await this.graph.export(id)
		return this.get(id)
	}

	/**
	 * 获取演示文稿导出文件下载信息。
	 *
	 * 主要负责：
	 * 1. 查询当前演示文稿任务。
	 * 2. 校验是否已经完成文件导出。
	 * 3. 检查导出文件是否真实存在。
	 * 4. 返回文件路径和文件名，供接口层提供下载。
	 */
	async getDownload(id: string): Promise<{ path: string; fileName: string }> {
		// 获取当前演示文稿状态
		const presentation = await this.get(id)

		// 没有导出记录，说明文件还未生成
		if (!presentation.exportRecord) {
			throw new Error('当前任务还没有导出文件。')
		}

		// 检查导出文件是否存在
		// 防止数据库中有记录，但实际文件已经丢失
		await access(presentation.exportRecord.filePath)

		return {
			// 返回文件实际存储路径
			path: presentation.exportRecord.filePath,

			// 返回下载时展示的文件名称
			fileName: presentation.exportRecord.fileName
		}
	}
}
