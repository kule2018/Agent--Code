import {
	END,
	START,
	Command,
	ReducedValue,
	StateGraph,
	StateSchema,
	interrupt
} from '@langchain/langgraph'
import * as z from 'zod'

const RequirementsSchema = z.object({
	topic: z.string(),
	audience: z.string(),
	pageCount: z.number().int()
})

const OutlineSchema = z.object({
	version: z.number().int(),
	title: z.string(),
	sections: z.array(z.string())
})

const ReviewDecisionSchema = z.object({
	action: z.enum(['approve', 'revise', 'reject']),
	outlineVersion: z.number().int(),
	feedback: z.string().nullable().default(null)
})

/** 定义大纲生成、人工审核和后续制作共同使用的工作流状态。 */
const WorkflowState = new StateSchema({
	presentationId: z.string(),
	requirements: RequirementsSchema.nullable().default(null),
	outline: OutlineSchema.nullable().default(null),
	reviewStatus: z
		.enum(['not_started', 'pending', 'approved', 'rejected'])
		.default('not_started'),
	reviewDecision: z
		.enum(['approve', 'revise', 'reject'])
		.nullable()
		.default(null),
	reviewFeedback: z.string().nullable().default(null),
	pageProductionStarted: z.boolean().default(false),
	executionPath: new ReducedValue(
		z.array(z.string()).default(() => []),
		{
			inputSchema: z.string(),
			reducer: (current, nodeName) => [...current, nodeName]
		}
	)
})

/** 整理本次演示文稿的制作要求。 */
function prepareRequirements() {
	console.log('[Node:prepare_requirements] 整理制作要求')

	return {
		requirements: {
			topic: 'Agent 大模型课程发布方案',
			audience: '企业技术负责人',
			pageCount: 3
		},
		executionPath: 'prepare_requirements'
	}
}

/** 生成第一版待审核大纲。 */
function generateOutline(state) {
	console.log('[Node:generate_outline] 生成 Outline v1')

	return {
		outline: {
			version: 1,
			title: state.requirements.topic,
			sections: ['业务需求', '课程方案', '合作与交付']
		},
		reviewStatus: 'pending',
		executionPath: 'generate_outline'
	}
}

/** 暂停工作流，把当前大纲交给用户审核。 */
function reviewOutline(state) {
	// 记录当前进入审核的大纲版本，方便观察工作流执行过程
	console.log(
		`[Node:review_outline] 等待审核 Outline v${state.outline.version}`
	)

	/**
	 * interrupt 会暂停当前 Graph，
	 * 并把大纲及允许执行的操作返回给外部应用。
	 *
	 * 用户完成审核后，工作流从这里恢复，
	 * interrupt 会返回用户提交的审核结果。
	 */
	const decision = ReviewDecisionSchema.parse(
		interrupt({
			type: 'outline_review',
			presentationId: state.presentationId,
			outlineVersion: state.outline.version,
			outline: state.outline,

			// 用户只能从批准、修改和拒绝三个动作中选择
			allowedActions: ['approve', 'revise', 'reject']
		})
	)

	// 保存本次审核结果，供后续节点决定工作流应该走哪条分支
	return {
		reviewDecision: decision.action,
		reviewFeedback: decision.feedback,
		executionPath: `review_${decision.action}`
	}
}

/** 根据用户提交的审核决定选择后续 Node。 */
function routeAfterReview(state) {
	return state.reviewDecision
}

/** 审核通过后开始创建页面制作任务。 */
function startPageProduction() {
	console.log('[Node:start_page_production] 大纲已批准，开始页面制作')

	return {
		reviewStatus: 'approved',
		pageProductionStarted: true,
		executionPath: 'start_page_production'
	}
}

/** 根据修改意见生成新版大纲，并再次进入人工审核。 */
function reviseOutline(state) {
	const nextVersion = state.outline.version + 1
	console.log(`[Node:revise_outline] 生成 Outline v${nextVersion}`)

	return {
		outline: {
			version: nextVersion,
			title: state.outline.title,
			sections: [
				...state.outline.sections.slice(0, -1),
				`修改说明：${state.reviewFeedback}`
			]
		},
		reviewStatus: 'pending',
		reviewDecision: null,
		reviewFeedback: null,
		executionPath: 'revise_outline'
	}
}

/** 用户拒绝后结束当前制作任务。 */
function rejectPresentation() {
	console.log('[Node:reject_presentation] 用户拒绝大纲，结束制作任务')

	return {
		reviewStatus: 'rejected',
		executionPath: 'reject_presentation'
	}
}

/** 从 StateSnapshot 中读取当前等待处理的审核请求。 */
export function getPendingReview(snapshot) {
	for (const task of snapshot.tasks) {
		for (const pendingInterrupt of task.interrupts ?? []) {
			if (pendingInterrupt.value?.type === 'outline_review') {
				return pendingInterrupt.value
			}
		}
	}

	return null
}

/** 在恢复 Graph 前校验当前提交是否仍对应待审核版本。 */
export function validateReviewSubmission(snapshot, submission) {
	const pendingReview = getPendingReview(snapshot)

	if (!pendingReview || snapshot.values.reviewStatus !== 'pending') {
		throw new Error('当前任务没有等待处理的大纲审核。')
	}

	if (submission.presentationId !== pendingReview.presentationId) {
		throw new Error('当前审核请求不属于这项演示文稿制作任务。')
	}

	if (submission.outlineVersion !== pendingReview.outlineVersion) {
		throw new Error(
			`审核版本已经过期：当前版本为 v${pendingReview.outlineVersion}。`
		)
	}

	if (submission.action === 'revise' && !submission.feedback?.trim()) {
		throw new Error('请求修改大纲时必须提供修改意见。')
	}

	return {
		action: submission.action,
		outlineVersion: submission.outlineVersion,
		feedback: submission.feedback ?? null
	}
}

/** 创建带有持久化人工审核能力的演示文稿制作流程。 */
export function createReviewWorkflow({ checkpointer }) {
	return new StateGraph(WorkflowState)
		.addNode('prepare_requirements', prepareRequirements)
		.addNode('generate_outline', generateOutline)
		.addNode('review_outline', reviewOutline)
		.addNode('start_page_production', startPageProduction)
		.addNode('revise_outline', reviseOutline)
		.addNode('reject_presentation', rejectPresentation)
		.addEdge(START, 'prepare_requirements')
		.addEdge('prepare_requirements', 'generate_outline')
		.addEdge('generate_outline', 'review_outline')
		.addConditionalEdges('review_outline', routeAfterReview, {
			approve: 'start_page_production',
			revise: 'revise_outline',
			reject: 'reject_presentation'
		})
		.addEdge('start_page_production', END)
		.addEdge('revise_outline', 'review_outline')
		.addEdge('reject_presentation', END)
		.compile({ checkpointer })
}

export { Command }
