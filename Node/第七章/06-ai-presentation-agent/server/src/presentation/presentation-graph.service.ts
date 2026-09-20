import {
	Inject,
	Injectable,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common'
import {
	Command,
	END,
	START,
	StateGraph,
	StateSchema,
	interrupt
} from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import * as z from 'zod'
import { PresentationAggregate } from './presentation.aggregate.js'
import { PresentationExportService } from './export.service.js'
import { PresentationModelService } from './model.service.js'
import {
	EditableRequirementsSchema,
	ReviewOutlineSchema,
	type EditablePresentationRequirements,
	type ReviewOutlineInput
} from './presentation.types.js'
import {
	DEFAULT_POSTGRES_URI,
	PresentationRepository
} from './presentation.repository.js'

const OperationSchema = z.enum([
	'create',
	'revise_requirements',
	'continue_pages',
	'revise_page',
	'export'
])

const WorkflowState = new StateSchema({
	presentationId: z.string(),
	operation: OperationSchema.default('create'),
	queue: z.array(z.string()).default(() => []),
	currentPageId: z.string().nullable().default(null),
	targetPageId: z.string().nullable().default(null),
	changeRequest: z.string().nullable().default(null),
	nextRequirements: EditableRequirementsSchema.nullable().default(null),
	reviewDecision: z
		.enum(['approve', 'revise', 'reject'])
		.nullable()
		.default(null),
	reviewFeedback: z.string().nullable().default(null),
	executionPath: z.array(z.string()).default(() => [])
})

interface WorkflowValue {
	presentationId: string
	operation: z.infer<typeof OperationSchema>
	queue: string[]
	currentPageId: string | null
	targetPageId: string | null
	changeRequest: string | null
	nextRequirements: EditablePresentationRequirements | null
	reviewDecision: 'approve' | 'revise' | 'reject' | null
	reviewFeedback: string | null
	executionPath: string[]
}

/** 把领域状态、模型能力和持久化 Checkpoint 连接成可恢复工作流。 */
@Injectable()
export class PresentationGraphService implements OnModuleInit, OnModuleDestroy {
	private readonly checkpointer = PostgresSaver.fromConnString(
		process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
	)
	private graph: any

	constructor(
		@Inject(PresentationRepository)
		private readonly repository: PresentationRepository,
		@Inject(PresentationModelService)
		private readonly models: PresentationModelService,
		@Inject(PresentationExportService)
		private readonly exporter: PresentationExportService
	) {}

	async onModuleInit(): Promise<void> {
		await this.checkpointer.setup()
		this.graph = this.createGraph()
	}

	async onModuleDestroy(): Promise<void> {
		await this.checkpointer.end()
	}

	/** 启动任务，生成第一版大纲后停在人工审核位置。 */
	async start(presentationId: string): Promise<void> {
		await this.graph.invoke(
			{ presentationId, operation: 'create' },
			this.config(presentationId)
		)
	}

	// 将用户的大纲审核结果传回 LangGraph，
	// 恢复之前因为 interrupt 暂停的工作流继续执行。
	async review(
		presentationId: string,
		decision: ReviewOutlineInput
	): Promise<void> {
		// 获取当前任务对应的 Graph 状态快照。
		// 通过 thread_id(presentationId) 找到之前暂停时保存的工作流状态。
		const snapshot = await this.graph.getState(this.config(presentationId))

		// 检查当前 Graph 是否真的停留在大纲审核节点。
		// 如果没有找到 pending review，说明当前任务没有等待用户操作。
		const pending = this.findPendingReview(snapshot)

		if (!pending) {
			throw new Error('当前任务没有等待处理的大纲审核。')
		}

		// 校验用户提交的审核版本是否仍然有效。
		// 防止用户打开旧页面后提交过期版本的审核结果。
		if (pending.outlineVersion !== decision.outlineVersion) {
			throw new Error(
				`审核版本已经过期：当前等待审核的是 Outline v${pending.outlineVersion}。`
			)
		}

		// 使用 Command({ resume }) 恢复之前暂停的 Graph。
		//
		// interrupt() 之前暂停的位置会继续执行，
		// 并且 interrupt() 的返回值就是这里传入的 decision。
		//
		// 例如：
		// reviewOutline:
		//
		// const decision = interrupt(...)
		//
		// 恢复后：
		// decision = 用户提交的 approve / revise / reject
		await this.graph.invoke(
			new Command({
				resume: decision
			}),
			this.config(presentationId)
		)
	}

	/** 只把未完成、失败或失效的页面重新放入执行队列。 */
	async continuePages(presentationId: string): Promise<void> {
		await this.invokeOperation(presentationId, 'continue_pages')
	}

	/** 只为指定页面创建新 Revision 并重新生成该页。 */
	async revisePage(
		presentationId: string,
		pageId: string,
		changeRequest: string
	): Promise<void> {
		await this.invokeOperation(presentationId, 'revise_page', {
			targetPageId: pageId,
			changeRequest
		})
	}

	/** 全局制作要求变化时生成新大纲版本，并重新进入人工审核。 */
	async reviseRequirements(
		presentationId: string,
		nextRequirements: EditablePresentationRequirements,
		instruction: string
	): Promise<void> {
		await this.invokeOperation(presentationId, 'revise_requirements', {
			nextRequirements,
			changeRequest: instruction
		})
	}

	/** 通过 Graph 执行导出校验和 PPTX 生成。 */
	async export(presentationId: string): Promise<void> {
		await this.invokeOperation(presentationId, 'export')
	}

	private createGraph() {
		return new StateGraph(WorkflowState)
			.addNode('route_operation', this.routeOperation)
			.addNode('generate_outline', this.generateOutline)
			.addNode('review_outline', this.reviewOutline)
			.addNode('revise_outline', this.reviseOutline)
			.addNode('prepare_pages', this.preparePages)
			.addNode('prepare_continue', this.prepareContinue)
			.addNode('prepare_page_revision', this.preparePageRevision)
			.addNode('select_page', this.selectPage)
			.addNode('generate_page', this.generatePage)
			.addNode('summarize_pages', this.summarizePages)
			.addNode('export_presentation', this.exportPresentation)
			.addNode('finish_rejected', this.finishRejected)
			.addEdge(START, 'route_operation')
			.addConditionalEdges('route_operation', this.routeAfterOperation, {
				generate_outline: 'generate_outline',
				revise_outline: 'revise_outline',
				prepare_continue: 'prepare_continue',
				prepare_page_revision: 'prepare_page_revision',
				export_presentation: 'export_presentation'
			})
			.addEdge('generate_outline', 'review_outline')
			.addConditionalEdges('review_outline', this.routeAfterReview, {
				prepare_pages: 'prepare_pages',
				revise_outline: 'revise_outline',
				finish_rejected: 'finish_rejected'
			})
			.addEdge('revise_outline', 'review_outline')
			.addConditionalEdges('prepare_pages', this.routeAfterQueuePrepared, {
				select_page: 'select_page',
				summarize_pages: 'summarize_pages'
			})
			.addConditionalEdges('prepare_continue', this.routeAfterQueuePrepared, {
				select_page: 'select_page',
				summarize_pages: 'summarize_pages'
			})
			.addEdge('prepare_page_revision', 'select_page')
			.addEdge('select_page', 'generate_page')
			.addConditionalEdges('generate_page', this.routeAfterPage, {
				select_page: 'select_page',
				summarize_pages: 'summarize_pages'
			})
			.addEdge('summarize_pages', END)
			.addEdge('export_presentation', END)
			.addEdge('finish_rejected', END)
			.compile({ checkpointer: this.checkpointer })
	}

	private readonly routeOperation = (state: WorkflowValue) => ({
		executionPath: [...state.executionPath, `operation:${state.operation}`]
	})

	private readonly routeAfterOperation = (state: WorkflowValue) => {
		const targets = {
			create: 'generate_outline',
			revise_requirements: 'revise_outline',
			continue_pages: 'prepare_continue',
			revise_page: 'prepare_page_revision',
			export: 'export_presentation'
		} as const
		console.log('state.operation', state.operation)
		return targets[state.operation]
	}

	// 生成演示文稿大纲节点。
	// 该节点负责读取当前任务状态，调用模型生成新版本大纲，
	// 并将生成结果保存到领域模型中。
	private readonly generateOutline = async (state: WorkflowValue) => {
		// 根据 presentationId 从仓储中加载当前演示文稿聚合，
		// 获取制作需求、已有大纲等完整业务状态。
		const aggregate = await this.load(state.presentationId)

		// 根据当前任务配置获取对应的大模型提供方，
		// 例如不同模型模式可能使用不同的 LLM 服务。
		const provider = this.models.getProvider(aggregate.toJSON().modelMode)

		// 获取当前已有的大纲。
		// 如果当前是用户提出修改意见后的重新生成，
		// 则会基于旧版本大纲继续优化。
		const previousOutline = aggregate.currentOutline

		// 调用模型生成新的大纲版本。
		const draft = await provider.generateOutline({
			// 用户最初提交的制作需求，
			// 例如主题、页数、目标用户等信息。
			requirements: aggregate.toJSON().requirements,

			// 根据当前已有版本号生成新的大纲版本。
			// 第一次生成时为 v1，修改后继续递增。
			version: (aggregate.toJSON().currentOutlineVersion ?? 0) + 1,

			// 将旧版本大纲传递给模型，
			// 方便模型理解已有内容并进行增量修改。
			previousOutline,

			// 如果这是一次修改流程，
			// 将用户审核阶段提出的反馈传递给模型。
			feedback: state.reviewFeedback
		})

		// 将模型生成的大纲添加到聚合根中。
		// 聚合内部负责维护版本号、当前有效大纲等业务规则。
		aggregate.addOutline(draft, state.reviewFeedback)

		// 保存更新后的演示文稿状态，
		// 包括新生成的大纲、版本信息等。
		await this.repository.save(aggregate.toJSON())

		// 返回本节点对工作流状态的更新。
		return {
			// 清空审核结果，
			// 因为生成新大纲后需要重新等待用户审核。
			reviewDecision: null,

			// 清空上一轮审核反馈，
			// 避免影响后续流程。
			reviewFeedback: null,

			// 记录当前节点执行轨迹，
			// 方便调试和查看 Agent 执行路径。
			executionPath: [...state.executionPath, 'generate_outline']
		}
	}

	// 大纲审核节点。
	// 该节点会暂停工作流，等待用户审核当前大纲。
	// 用户可以选择：批准、要求修改、拒绝。
	private readonly reviewOutline = async (state: WorkflowValue) => {
		// 在进入人工审核前加载最新的演示文稿状态。
		// 这里重新读取数据库中的数据，而不是直接使用 Graph State，
		// 保证审核时拿到最新的大纲版本。
		const beforeInterrupt = await this.load(state.presentationId)

		// 获取当前需要审核的大纲。
		const outline = beforeInterrupt.currentOutline

		// 如果不存在可审核的大纲，说明工作流状态异常。
		if (!outline) {
			throw new Error('没有找到待审核大纲。')
		}

		// 使用 interrupt 暂停 LangGraph 工作流。
		// 工作流会停留在这里，等待前端提交用户审核结果。
		//
		// 用户恢复工作流时，会通过 Command({ resume: decision })
		// 将审核结果传递回来。
		const decision = ReviewOutlineSchema.parse(
			interrupt({
				// 标识当前等待的是大纲审核事件。
				type: 'outline_review',

				// 当前审核对应的任务 ID。
				presentationId: state.presentationId,

				// 当前审核的大纲版本。
				outlineVersion: outline.version,

				// 前端允许用户执行的操作。
				allowedActions: ['approve', 'revise', 'reject']
			})
		)

		// 如果用户选择修改大纲，
		// 必须提供具体反馈，否则无法指导下一次生成。
		if (decision.decision === 'revise' && !decision.feedback.trim()) {
			throw new Error('要求修改大纲时，必须填写具体修改意见。')
		}

		// interrupt 恢复以后，当前函数会继续执行。
		// 重新从数据库加载聚合，避免使用暂停之前缓存的旧对象。
		const aggregate = await this.load(state.presentationId)

		// 校验当前审核版本是否仍然有效。
		// 防止用户审核了已经过期的大纲版本。
		aggregate.assertReviewable(decision.outlineVersion)

		// 用户批准当前大纲。
		// 更新领域状态，并保存最新聚合。
		if (decision.decision === 'approve') {
			aggregate.approveOutline(decision.outlineVersion)

			await this.repository.save(aggregate.toJSON())
		}

		// 用户拒绝当前大纲。
		// 保存拒绝状态以及用户填写的原因。
		if (decision.decision === 'reject') {
			aggregate.rejectOutline(decision.outlineVersion, decision.feedback)

			await this.repository.save(aggregate.toJSON())
		}

		// 返回 Graph State 更新内容。
		// 后续 Conditional Edge 会根据 reviewDecision 决定下一步流程。
		return {
			// 用户最终选择：
			// approve -> 进入页面制作流程
			// revise  -> 重新生成大纲
			// reject  -> 结束任务
			reviewDecision: decision.decision,

			// 用户修改意见，
			// 后续 revise_outline 节点会使用。
			reviewFeedback: decision.feedback,

			// 记录 Agent 执行轨迹，方便调试和查看流程。
			executionPath: [...state.executionPath, `review:${decision.decision}`]
		}
	}

	// 根据用户的大纲审核结果，决定工作流下一步执行哪个节点。
	// 该函数会被 addConditionalEdges 调用，用于动态路由。
	private readonly routeAfterReview = (state: WorkflowValue) => {
		// 用户批准当前大纲：
		// 说明大纲已经确认，可以进入页面制作阶段。
		if (state.reviewDecision === 'approve') {
			return 'prepare_pages'
		}
		// 用户要求修改大纲：
		// 进入重新生成大纲流程，
		// 后续会携带 reviewFeedback 作为修改依据。
		if (state.reviewDecision === 'revise') {
			return 'revise_outline'
		}
		// 用户拒绝大纲：
		// 结束当前制作任务。
		// 这里默认处理 reject 或其他未知状态。
		return 'finish_rejected'
	}

	// 修改已有大纲节点。
	// 当用户在审核阶段选择 revise 后，
	// 该节点会根据用户反馈重新生成一个新的大纲版本。
	private readonly reviseOutline = async (state: WorkflowValue) => {
		// 根据演示文稿 ID 加载当前聚合根，
		// 获取当前需求、大纲版本等完整业务状态。
		const aggregate = await this.load(state.presentationId)

		// 根据当前任务配置获取对应的大模型提供方。
		// 不同 modelMode 可以对应不同模型服务。
		const provider = this.models.getProvider(aggregate.toJSON().modelMode)

		// 获取当前正在使用的大纲。
		// 修改大纲需要基于旧版本进行增量调整。
		const previousOutline = aggregate.currentOutline

		// 如果当前没有大纲，说明流程状态异常，
		// 无法执行修改操作。
		if (!previousOutline) {
			throw new Error('没有找到需要修改的大纲。')
		}

		// 获取用户本轮提出的修改意见。
		//
		// 优先使用 changeRequest：
		// 通常用于用户修改制作需求后的重新生成。
		//
		// 如果没有 changeRequest，
		// 则使用审核阶段填写的 reviewFeedback。
		const feedback = state.changeRequest ?? state.reviewFeedback

		// 获取当前保存的制作需求。
		const currentRequirements = aggregate.toJSON().requirements

		// 判断用户是否修改了制作需求。
		//
		// 如果存在 nextRequirements，
		// 则将新的需求合并到旧需求中。
		//
		// 如果没有，则继续沿用原来的需求。
		const nextRequirements = state.nextRequirements
			? {
					...currentRequirements,
					...state.nextRequirements
				}
			: currentRequirements

		// 调用大模型生成新的大纲版本。
		//
		// 输入：
		// - 最新制作需求
		// - 当前大纲版本号 + 1
		// - 原大纲
		// - 用户修改意见
		//
		// 输出：
		// - 新版本大纲 draft
		const draft = await provider.generateOutline({
			// 使用更新后的制作要求生成大纲
			requirements: nextRequirements,

			// 新大纲版本递增
			version: previousOutline.version + 1,

			// 将旧版本传给模型，
			// 让模型基于已有内容修改，而不是重新生成。
			previousOutline,

			// 用户反馈，
			// 指导模型调整方向。
			feedback
		})

		// 如果用户修改了制作需求，
		// 先更新聚合中的需求信息。
		//
		// 例如：
		// 原需求：制作 10 页技术分享 PPT
		// 修改后：改成 15 页面向客户的 PPT
		if (state.nextRequirements) {
			aggregate.updateRequirements(
				state.nextRequirements,

				// 如果没有反馈文本，
				// 使用默认更新原因。
				feedback ?? '更新制作要求'
			)
		}

		// 将新生成的大纲加入聚合根。
		//
		// 聚合内部负责维护：
		// - 大纲版本号
		// - 当前有效大纲
		// - 历史版本记录
		aggregate.addOutline(draft, feedback)

		// 保存最新任务状态。
		// 包括：
		// - 新版本大纲
		// - 更新后的制作需求
		// - 当前任务状态
		await this.repository.save(aggregate.toJSON())

		// 更新 LangGraph 工作流状态。
		return {
			// 修改后的大纲需要重新审核，
			// 所以清空之前的审核结果。
			reviewDecision: null,

			// 清空旧反馈，
			// 避免影响下一轮审核。
			reviewFeedback: null,

			// 清空本次修改请求。
			changeRequest: null,

			// 清空新的制作需求修改。
			nextRequirements: null,

			// 记录当前节点执行轨迹。
			executionPath: [...state.executionPath, 'revise_outline']
		}
	}

	private readonly preparePages = async (state: WorkflowValue) => {
		const aggregate = await this.load(state.presentationId)
		aggregate.ensurePageTasks()
		await this.repository.save(aggregate.toJSON())
		return {
			queue: aggregate.getPendingPageIds(),
			currentPageId: null,
			executionPath: [...state.executionPath, 'prepare_pages']
		}
	}

	private readonly prepareContinue = async (state: WorkflowValue) => {
		const aggregate = await this.load(state.presentationId)
		return {
			queue: aggregate.getPendingPageIds(),
			currentPageId: null,
			executionPath: [...state.executionPath, 'prepare_continue']
		}
	}

	private readonly preparePageRevision = async (state: WorkflowValue) => {
		if (!state.targetPageId || !state.changeRequest) {
			throw new Error('单页修改缺少 pageId 或修改要求。')
		}
		const aggregate = await this.load(state.presentationId)
		aggregate.requestPageRevision(state.targetPageId, state.changeRequest)
		await this.repository.save(aggregate.toJSON())
		return {
			queue: [state.targetPageId],
			currentPageId: null,
			executionPath: [...state.executionPath, 'prepare_page_revision']
		}
	}

	private readonly routeAfterQueuePrepared = (state: WorkflowValue) =>
		state.queue.length > 0 ? 'select_page' : 'summarize_pages'

	private readonly selectPage = (state: WorkflowValue) => {
		const [currentPageId, ...queue] = state.queue
		if (!currentPageId) throw new Error('页面执行队列为空。')
		return {
			currentPageId,
			queue,
			executionPath: [...state.executionPath, `select:${currentPageId}`]
		}
	}

	private readonly generatePage = async (state: WorkflowValue) => {
		if (!state.currentPageId) throw new Error('没有指定当前页面。')
		const aggregate = await this.load(state.presentationId)
		const provider = this.models.getProvider(aggregate.toJSON().modelMode)
		const page = aggregate.startPage(state.currentPageId)
		await this.repository.save(aggregate.toJSON())

		try {
			// Replay 中稳定注入一次失败，用来验证部分成功和断点续做。
			if (
				provider.mode === 'replay' &&
				page.order === 3 &&
				page.pageRevision === 1 &&
				page.attempts === 1
			) {
				throw new Error('页面生成服务暂时不可用')
			}

			const latest = await this.load(state.presentationId)
			const outline = latest.currentOutline
			if (!outline) throw new Error('没有找到当前大纲。')
			const currentPage = latest.getPage(state.currentPageId)
			const content = await provider.generatePage({
				requirements: latest.toJSON().requirements,
				outline,
				page: currentPage
			})
			latest.completePage(state.currentPageId, content)
			await this.repository.save(latest.toJSON())
		} catch (error) {
			const failed = await this.load(state.presentationId)
			failed.failPage(
				state.currentPageId,
				error instanceof Error ? error.message : '页面生成失败'
			)
			await this.repository.save(failed.toJSON())
		}

		return {
			executionPath: [...state.executionPath, `generate:${state.currentPageId}`]
		}
	}

	private readonly routeAfterPage = (state: WorkflowValue) =>
		state.queue.length > 0 ? 'select_page' : 'summarize_pages'

	private readonly summarizePages = (state: WorkflowValue) => ({
		currentPageId: null,
		executionPath: [...state.executionPath, 'summarize_pages']
	})

	private readonly exportPresentation = async (state: WorkflowValue) => {
		const aggregate = await this.load(state.presentationId)
		const pages = aggregate.assertExportable()
		const outline = aggregate.currentOutline
		if (!outline) throw new Error('没有找到当前大纲。')
		const record = await this.exporter.export(
			aggregate.toJSON(),
			outline,
			pages
		)
		aggregate.recordExport(record)
		await this.repository.save(aggregate.toJSON())
		return {
			executionPath: [...state.executionPath, 'export_presentation']
		}
	}

	private readonly finishRejected = (state: WorkflowValue) => ({
		executionPath: [...state.executionPath, 'finish_rejected']
	})

	private async invokeOperation(
		presentationId: string,
		operation: z.infer<typeof OperationSchema>,
		extra: Partial<WorkflowValue> = {}
	): Promise<void> {
		const config = this.config(presentationId)
		const snapshot = await this.graph.getState(config)
		if (!snapshot.values.presentationId) {
			throw new Error('没有找到该任务的工作流状态。')
		}
		await this.graph.invoke(
			{
				...snapshot.values,
				operation,
				queue: [],
				currentPageId: null,
				targetPageId: null,
				changeRequest: null,
				nextRequirements: null,
				reviewDecision: null,
				reviewFeedback: null,
				...extra
			},
			config
		)
	}

	private async load(presentationId: string): Promise<PresentationAggregate> {
		const value = await this.repository.findById(presentationId)
		if (!value) throw new Error(`没有找到演示文稿任务：${presentationId}`)
		return PresentationAggregate.restore(value)
	}

	private config(presentationId: string) {
		return { configurable: { thread_id: `presentation:${presentationId}` } }
	}

	private findPendingReview(
		snapshot: any
	): { outlineVersion: number; presentationId: string } | null {
		for (const task of snapshot.tasks ?? []) {
			for (const pendingInterrupt of task.interrupts ?? []) {
				if (pendingInterrupt.value?.type === 'outline_review') {
					return pendingInterrupt.value
				}
			}
		}
		return null
	}
}
