import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
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

	/** 把用户决定传回 interrupt，继续原来的 Graph。 */
	async review(
		presentationId: string,
		decision: ReviewOutlineInput
	): Promise<void> {
		const snapshot = await this.graph.getState(this.config(presentationId))
		const pending = this.findPendingReview(snapshot)
		if (!pending) throw new Error('当前任务没有等待处理的大纲审核。')
		if (pending.outlineVersion !== decision.outlineVersion) {
			throw new Error(
				`审核版本已经过期：当前等待审核的是 Outline v${pending.outlineVersion}。`
			)
		}
		await this.graph.invoke(
			new Command({ resume: decision }),
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
		return targets[state.operation]
	}

	private readonly generateOutline = async (state: WorkflowValue) => {
		const aggregate = await this.load(state.presentationId)
		const provider = this.models.getProvider(aggregate.toJSON().modelMode)
		const previousOutline = aggregate.currentOutline
		const draft = await provider.generateOutline({
			requirements: aggregate.toJSON().requirements,
			version: (aggregate.toJSON().currentOutlineVersion ?? 0) + 1,
			previousOutline,
			feedback: state.reviewFeedback
		})
		aggregate.addOutline(draft, state.reviewFeedback)
		await this.repository.save(aggregate.toJSON())
		return {
			reviewDecision: null,
			reviewFeedback: null,
			executionPath: [...state.executionPath, 'generate_outline']
		}
	}

	private readonly reviewOutline = async (state: WorkflowValue) => {
		const beforeInterrupt = await this.load(state.presentationId)
		const outline = beforeInterrupt.currentOutline
		if (!outline) throw new Error('没有找到待审核大纲。')

		const decision = ReviewOutlineSchema.parse(
			interrupt({
				type: 'outline_review',
				presentationId: state.presentationId,
				outlineVersion: outline.version,
				allowedActions: ['approve', 'revise', 'reject']
			})
		)
		if (decision.decision === 'revise' && !decision.feedback.trim()) {
			throw new Error('要求修改大纲时，必须填写具体修改意见。')
		}

		// interrupt 恢复后重新加载，避免使用暂停以前的旧业务对象。
		const aggregate = await this.load(state.presentationId)
		aggregate.assertReviewable(decision.outlineVersion)
		if (decision.decision === 'approve') {
			aggregate.approveOutline(decision.outlineVersion)
			await this.repository.save(aggregate.toJSON())
		}
		if (decision.decision === 'reject') {
			aggregate.rejectOutline(decision.outlineVersion, decision.feedback)
			await this.repository.save(aggregate.toJSON())
		}

		return {
			reviewDecision: decision.decision,
			reviewFeedback: decision.feedback,
			executionPath: [
				...state.executionPath,
				`review:${decision.decision}`
			]
		}
	}

	private readonly routeAfterReview = (state: WorkflowValue) => {
		if (state.reviewDecision === 'approve') return 'prepare_pages'
		if (state.reviewDecision === 'revise') return 'revise_outline'
		return 'finish_rejected'
	}

	private readonly reviseOutline = async (state: WorkflowValue) => {
		const aggregate = await this.load(state.presentationId)
		const provider = this.models.getProvider(aggregate.toJSON().modelMode)
		const previousOutline = aggregate.currentOutline
		if (!previousOutline) throw new Error('没有找到需要修改的大纲。')
		const feedback = state.changeRequest ?? state.reviewFeedback
		const currentRequirements = aggregate.toJSON().requirements
		const nextRequirements = state.nextRequirements
			? { ...currentRequirements, ...state.nextRequirements }
			: currentRequirements
		const draft = await provider.generateOutline({
			requirements: nextRequirements,
			version: previousOutline.version + 1,
			previousOutline,
			feedback
		})
		if (state.nextRequirements) {
			aggregate.updateRequirements(state.nextRequirements, feedback ?? '更新制作要求')
		}
		aggregate.addOutline(draft, feedback)
		await this.repository.save(aggregate.toJSON())
		return {
			reviewDecision: null,
			reviewFeedback: null,
			changeRequest: null,
			nextRequirements: null,
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
			executionPath: [
				...state.executionPath,
				`generate:${state.currentPageId}`
			]
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

	private findPendingReview(snapshot: any):
		| { outlineVersion: number; presentationId: string }
		| null {
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
