import { END, START, StateGraph, StateSchema } from '@langchain/langgraph'
import * as z from 'zod'

const OperationSchema = z.enum([
	'initial',
	'continue',
	'revise_page',
	'publish_outline',
	'export'
])

const PageTaskSchema = z.object({
	pageId: z.string(),
	title: z.string(),
	outlineVersion: z.number().int(),
	pageRevision: z.number().int(),
	status: z.enum(['pending', 'completed', 'failed', 'stale']),
	attempts: z.number().int(),
	currentArtifactId: z.string().nullable(),
	lastError: z.string().nullable()
})

const PageArtifactSchema = z.object({
	artifactId: z.string(),
	pageId: z.string(),
	title: z.string(),
	outlineVersion: z.number().int(),
	pageRevision: z.number().int(),
	content: z.string()
})

const ExportResultSchema = z.object({
	ok: z.boolean(),
	reason: z.string(),
	artifactIds: z.array(z.string())
})

/** 保存页面任务、页面产物以及当前运行进度。 */
const WorkflowState = new StateSchema({
	presentationId: z.string(),
	operation: OperationSchema.default('initial'),
	targetPageId: z.string().nullable().default(null),
	changeRequest: z.string().nullable().default(null),
	outlineVersion: z.number().int().default(1),
	outlineSections: z.array(z.string()).default(() => []),
	pageTasks: z.array(PageTaskSchema).default(() => []),
	artifacts: z.array(PageArtifactSchema).default(() => []),
	queue: z.array(z.string()).default(() => []),
	currentPageId: z.string().nullable().default(null),
	runStatus: z
		.enum([
			'not_started',
			'running',
			'partially_completed',
			'waiting_generation',
			'completed',
			'export_blocked',
			'exported'
		])
		.default('not_started'),
	exportResult: ExportResultSchema.nullable().default(null),
	executionPath: z.array(z.string()).default(() => [])
})

const INITIAL_SECTIONS = ['业务需求', '课程方案', '技术架构', '合作与交付']

/** 创建与当前大纲对应的页面任务。 */
function createPageTasks(sections, outlineVersion) {
	return sections.map((title, index) => ({
		pageId: `page-${index + 1}`,
		title,
		outlineVersion,
		pageRevision: 1,
		status: 'pending',
		attempts: 0,
		currentArtifactId: null,
		lastError: null
	}))
}

/** 根据本次操作准备真正需要执行的页面队列。 */
function prepareRun(state) {
	console.log(`[Node:prepare_run] 准备操作：${state.operation}`)

	if (state.operation === 'initial') {
		if (state.pageTasks.length > 0) {
			throw new Error('当前任务已经初始化，请先执行 npm run reset。')
		}

		const outlineSections = INITIAL_SECTIONS
		const pageTasks = createPageTasks(outlineSections, state.outlineVersion)

		return {
			outlineSections,
			pageTasks,
			queue: pageTasks.map((task) => task.pageId),
			runStatus: 'running',
			exportResult: null,
			executionPath: [...state.executionPath, 'prepare_initial']
		}
	}

	if (state.operation === 'continue') {
		const targetIds = state.pageTasks
			.filter((task) => task.status !== 'completed')
			.map((task) => task.pageId)

		const pageTasks = state.pageTasks.map((task) => {
			if (!targetIds.includes(task.pageId)) {
				return task
			}

			const versionChanged = task.outlineVersion !== state.outlineVersion
			return {
				...task,
				outlineVersion: state.outlineVersion,
				pageRevision: versionChanged ? 1 : task.pageRevision,
				status: 'pending',
				currentArtifactId: null,
				lastError: null
			}
		})

		return {
			pageTasks,
			queue: targetIds,
			runStatus: targetIds.length > 0 ? 'running' : 'completed',
			exportResult: null,
			executionPath: [...state.executionPath, 'prepare_continue']
		}
	}

	if (state.operation === 'revise_page') {
		const target = state.pageTasks.find(
			(task) => task.pageId === state.targetPageId
		)

		if (!target) {
			throw new Error(`没有找到页面任务：${state.targetPageId}`)
		}

		const pageTasks = state.pageTasks.map((task) =>
			task.pageId === state.targetPageId
				? {
						...task,
						pageRevision: task.pageRevision + 1,
						status: 'pending',
						currentArtifactId: null,
						lastError: null
					}
				: task
		)

		return {
			pageTasks,
			queue: [state.targetPageId],
			runStatus: 'running',
			exportResult: null,
			executionPath: [
				...state.executionPath,
				`prepare_revise:${state.targetPageId}`
			]
		}
	}

	if (state.operation === 'publish_outline') {
		const nextOutlineVersion = state.outlineVersion + 1
		const outlineSections = state.outlineSections.map((title, index) =>
			index === 1 ? '核心能力与落地方案' : title
		)

		return {
			outlineVersion: nextOutlineVersion,
			outlineSections,
			pageTasks: state.pageTasks.map((task, index) => ({
				...task,
				title: outlineSections[index],
				status: 'stale',
				lastError: `当前产物属于 Outline v${task.outlineVersion}`
			})),
			queue: [],
			runStatus: 'waiting_generation',
			exportResult: null,
			executionPath: [
				...state.executionPath,
				`publish_outline:v${nextOutlineVersion}`
			]
		}
	}

	return {
		queue: [],
		executionPath: [...state.executionPath, 'prepare_export']
	}
}

/** 决定准备完成以后进入页面生成、导出校验还是直接收尾。 */
function routeAfterPrepare(state) {
	if (state.operation === 'export') {
		return 'validate_export'
	}

	return state.queue.length > 0 ? 'select_page' : 'summarize_run'
}

/** 从待处理队列中取出下一页。 */
function selectPage(state) {
	const [currentPageId, ...queue] = state.queue

	return {
		currentPageId,
		queue,
		executionPath: [...state.executionPath, `select:${currentPageId}`]
	}
}

/** 为页面和版本生成稳定的产物 ID，真实项目中可作为幂等键。 */
function createArtifactId(presentationId, task) {
	return [
		presentationId,
		`outline-v${task.outlineVersion}`,
		task.pageId,
		`revision-${task.pageRevision}`
	].join(':')
}

/** 模拟页面生成服务，并把成功或失败结果写回页面任务。 */
function generatePage(state) {
	const task = state.pageTasks.find(
		(item) => item.pageId === state.currentPageId
	)

	if (!task) {
		throw new Error(`没有找到当前页面：${state.currentPageId}`)
	}

	const attempts = task.attempts + 1
	console.log(
		`[Node:generate_page] ${task.pageId} / Outline v${task.outlineVersion} / 页面 r${task.pageRevision}`
	)

	// 第一次制作 Outline v1 的第三页时返回失败，用来观察部分成功。
	if (
		task.pageId === 'page-3' &&
		task.outlineVersion === 1 &&
		task.pageRevision === 1 &&
		attempts === 1
	) {
		console.log('  -> 页面生成服务暂时不可用，本页标记为 failed')

		return {
			pageTasks: state.pageTasks.map((item) =>
				item.pageId === task.pageId
					? {
							...item,
							attempts,
							status: 'failed',
							lastError: '页面生成服务暂时不可用'
						}
					: item
			),
			executionPath: [...state.executionPath, `failed:${task.pageId}`]
		}
	}

	const artifactId = createArtifactId(state.presentationId, task)
	const existingArtifact = state.artifacts.find(
		(artifact) => artifact.artifactId === artifactId
	)
	const artifact = existingArtifact ?? {
		artifactId,
		pageId: task.pageId,
		title: task.title,
		outlineVersion: task.outlineVersion,
		pageRevision: task.pageRevision,
		content: state.changeRequest
			? `${task.title}：${state.changeRequest}`
			: `${task.title}：这是 Outline v${task.outlineVersion} 下生成的页面内容。`
	}

	console.log(
		existingArtifact
			? `  -> 复用已有产物 ${artifactId}`
			: `  -> 生成产物 ${artifactId}`
	)

	return {
		pageTasks: state.pageTasks.map((item) =>
			item.pageId === task.pageId
				? {
						...item,
						attempts,
						status: 'completed',
						currentArtifactId: artifactId,
						lastError: null
					}
				: item
		),
		artifacts: existingArtifact
			? state.artifacts
			: [...state.artifacts, artifact],
		executionPath: [...state.executionPath, `completed:${task.pageId}`]
	}
}

/** 当前队列还有页面时继续循环，否则汇总本次运行。 */
function routeAfterPage(state) {
	return state.queue.length > 0 ? 'select_page' : 'summarize_run'
}

/** 根据每一页的状态计算整项任务的结果。 */
function summarizeRun(state) {
	const hasFailed = state.pageTasks.some((task) => task.status === 'failed')
	const hasStale = state.pageTasks.some((task) => task.status === 'stale')
	const hasPending = state.pageTasks.some((task) => task.status === 'pending')

	let runStatus = 'completed'
	if (hasStale) {
		runStatus = 'waiting_generation'
	} else if (hasFailed || hasPending) {
		runStatus = 'partially_completed'
	}

	console.log(`[Node:summarize_run] 本次任务状态：${runStatus}`)

	return {
		currentPageId: null,
		runStatus,
		executionPath: [...state.executionPath, `summarize:${runStatus}`]
	}
}

/** 导出以前确认每一页都来自当前大纲和当前页面修订。 */
function validateExport(state) {
	const invalidPages = []
	const artifactIds = []

	for (const task of state.pageTasks) {
		const artifact = state.artifacts.find(
			(item) => item.artifactId === task.currentArtifactId
		)

		const valid =
			task.status === 'completed' &&
			artifact &&
			artifact.outlineVersion === state.outlineVersion &&
			artifact.pageRevision === task.pageRevision

		if (!valid) {
			invalidPages.push(task.pageId)
			continue
		}

		artifactIds.push(artifact.artifactId)
	}

	if (invalidPages.length > 0) {
		const reason = `以下页面缺少当前版本的有效产物：${invalidPages.join(', ')}`
		console.log(`[Node:validate_export] 导出被阻止：${reason}`)

		return {
			runStatus: 'export_blocked',
			exportResult: { ok: false, reason, artifactIds: [] },
			executionPath: [...state.executionPath, 'export_blocked']
		}
	}

	console.log('[Node:validate_export] 版本校验通过，可以导出')

	return {
		runStatus: 'exported',
		exportResult: {
			ok: true,
			reason: `全部页面均来自 Outline v${state.outlineVersion}`,
			artifactIds
		},
		executionPath: [...state.executionPath, 'exported']
	}
}

/** 创建支持部分成功、局部重做和版本校验的页面制作流程。 */
export function createPartialGenerationWorkflow({ checkpointer }) {
	return new StateGraph(WorkflowState)
		.addNode('prepare_run', prepareRun)
		.addNode('select_page', selectPage)
		.addNode('generate_page', generatePage)
		.addNode('summarize_run', summarizeRun)
		.addNode('validate_export', validateExport)
		.addEdge(START, 'prepare_run')
		.addConditionalEdges('prepare_run', routeAfterPrepare, {
			select_page: 'select_page',
			summarize_run: 'summarize_run',
			validate_export: 'validate_export'
		})
		.addEdge('select_page', 'generate_page')
		.addConditionalEdges('generate_page', routeAfterPage, {
			select_page: 'select_page',
			summarize_run: 'summarize_run'
		})
		.addEdge('summarize_run', END)
		.addEdge('validate_export', END)
		.compile({ checkpointer })
}
