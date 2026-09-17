import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import {
	Command,
	createReviewWorkflow,
	getPendingReview,
	validateReviewSubmission
} from './workflow.js'

const mode = process.argv[2]
const supportedModes = new Set([
	'reset',
	'start',
	'status',
	'approve',
	'revise',
	'reject',
	'approve-stale'
])
const threadId = 'presentation-review-1001'

if (!supportedModes.has(mode)) {
	throw new Error(
		'请通过 npm run reset、start、status、approve、revise 或 reject 运行案例。'
	)
}

/** 获取课程案例使用的 PostgreSQL 连接地址。 */
function getPostgresUri() {
	return (
		process.env.POSTGRES_URI ??
		'postgresql://agent_course:agent_course@localhost:5434/agent_review'
	)
}

/** 返回本案例固定使用的 Thread Config。 */
function createConfig() {
	return {
		configurable: {
			thread_id: threadId
		}
	}
}

/** 打印当前工作流以及待审核内容。 */
function printStatus(snapshot) {
	const pendingReview = getPendingReview(snapshot)

	console.log(
		JSON.stringify(
			{
				presentationId: snapshot.values.presentationId ?? null,
				outline: snapshot.values.outline ?? null,
				reviewStatus: snapshot.values.reviewStatus ?? null,
				pageProductionStarted: snapshot.values.pageProductionStarted ?? false,
				next: snapshot.next,
				pendingReview,
				executionPath: snapshot.values.executionPath ?? []
			},
			null,
			2
		)
	)
}

/** 第一次启动工作流，运行到人工审核位置。 */
async function startWorkflow(graph, config) {
	console.log('========== 启动演示文稿制作流程 ==========')
	await graph.invoke(
		{
			presentationId: 'PRESENTATION-1001'
		},
		config
	)

	console.log('\n工作流已经暂停，等待用户审核。')
	printStatus(await graph.getState(config))
}

/** 读取 Checkpoint，只查看当前审核状态。 */
async function showStatus(graph, config) {
	console.log('========== 读取待审核任务 ==========')
	const snapshot = await graph.getState(config)

	if (!snapshot.values.presentationId) {
		console.log('没有找到审核任务，请先执行 npm run start。')
		return
	}

	printStatus(snapshot)
}

/** 创建批准、修改或者拒绝所需的审核提交。 */
function createSubmission(action, pendingReview) {
	if (mode === 'approve-stale') {
		return {
			presentationId: pendingReview.presentationId,
			outlineVersion: pendingReview.outlineVersion - 1,
			action: 'approve',
			feedback: null
		}
	}

	return {
		presentationId: pendingReview.presentationId,
		outlineVersion: pendingReview.outlineVersion,
		action,
		feedback:
			action === 'revise' ? '增加一页企业 Agent 落地风险与控制方案。' : null
	}
}

/** 校验审核请求，并通过 Command 恢复原来的工作流。 */
async function submitReview(graph, config, action) {
	// 读取当前 Thread 保存的最新工作流状态
	const snapshot = await graph.getState(config)

	// 从 State 中找到之前由 interrupt() 产生的待审核请求
	const pendingReview = getPendingReview(snapshot)

	// 如果没有待处理的 interrupt，说明当前工作流并没有停在审核节点
	if (!pendingReview) {
		throw new Error('没有找到待处理的审核请求，请先执行 npm run start。')
	}

	// 根据用户选择的 action 和当前待审核信息，构造本次提交数据
	const submission = createSubmission(action, pendingReview)

	// 校验提交内容是否合法，例如审核版本是否仍然与当前大纲版本一致
	const decision = validateReviewSubmission(snapshot, submission)

	console.log('========== 提交审核决定 ==========')
	console.log(JSON.stringify(submission, null, 2))

	/**
	 * 通过 Command.resume 把审核结果传回之前的 interrupt()，
	 * 工作流会从暂停的位置继续执行，而不是重新从头开始。
	 */
	await graph.invoke(new Command({ resume: decision }), config)

	// 工作流恢复并执行完成后，再读取最新状态查看处理结果
	console.log('\n审核处理完成后的最新状态：')
	printStatus(await graph.getState(config))
}

/** 连接持久化存储，并执行一次独立的审核操作。 */
async function main() {
	const checkpointer = PostgresSaver.fromConnString(getPostgresUri())
	const config = createConfig()

	try {
		await checkpointer.setup()

		if (mode === 'reset') {
			await checkpointer.deleteThread(threadId)
			console.log(`已清理工作流：${threadId}`)
			return
		}

		const graph = createReviewWorkflow({ checkpointer })

		if (mode === 'start') {
			await startWorkflow(graph, config)
			return
		}

		if (mode === 'status') {
			await showStatus(graph, config)
			return
		}

		const action = mode === 'approve-stale' ? 'approve' : mode
		await submitReview(graph, config, action)
	} finally {
		await checkpointer.end()
	}
}

main().catch((error) => {
	console.error(`审核失败：${error.message}`)
	process.exitCode = 1
})
