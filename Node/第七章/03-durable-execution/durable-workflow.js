import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { createPresentationWorkflow } from './workflow.js'

const mode = process.argv[2]
const supportedModes = new Set(['reset', 'start', 'status', 'resume'])
const threadId = 'presentation-workflow-1001'

if (!supportedModes.has(mode)) {
	throw new Error('请通过 npm run reset、start、status 或 resume 运行案例。')
}

/** 获取课程案例使用的 PostgreSQL 连接地址。 */
function getPostgresUri() {
	return (
		process.env.POSTGRES_URI ??
		'postgresql://agent_course:agent_course@localhost:5433/agent_workflow'
	)
}

/** 返回当前工作流固定使用的 Thread Config。 */
function createConfig() {
	return {
		configurable: {
			thread_id: threadId
		}
	}
}

/** 打印最新 Checkpoint 中最值得观察的三部分信息。 */
function printSnapshot(snapshot) {
	console.log('\n最新 Checkpoint：')
	console.log(
		JSON.stringify(
			{
				values: {
					presentationId: snapshot.values.presentationId,
					requirements: snapshot.values.requirements,
					outline: snapshot.values.outline,
					draftSaved: snapshot.values.draftSaved,
					executionPath: snapshot.values.executionPath
				},
				next: snapshot.next,
				tasks: snapshot.tasks.map((task) => ({
					name: task.name,
					error: task.error ?? null
				}))
			},
			null,
			2
		)
	)
}

/** 第一次运行流程，并在保存草稿节点模拟一次故障。 */
async function startWorkflow(graph, config) {
	console.log('========== 第一次进程：启动制作流程 ==========')

	try {
		await graph.invoke(
			{
				presentationId: 'PRESENTATION-1001'
			},
			config
		)
	} catch (error) {
		console.log(`\n流程中断：${error.message}`)
		console.log('当前 Node.js 进程即将结束。')
	}
}

/** 读取数据库中保存的最新工作流状态，不执行任何 Node。 */
async function showWorkflowStatus(graph, config) {
	console.log('========== 新进程：读取工作流进度 ==========')

	// 根据当前 thread_id 读取最近一次保存的工作流快照。
	// getState() 只读取 Checkpoint，不会触发任何 Node 执行。
	const snapshot = await graph.getState(config)

	// 如果没有 presentationId，说明当前 Thread 下还没有可恢复的工作流状态。
	if (!snapshot.values.presentationId) {
		console.log('没有找到待恢复的工作流，请先执行 npm run start。')
		return
	}

	// 打印当前保存的状态，用于查看工作流已经执行到哪里。
	printSnapshot(snapshot)
}

/** 使用相同 thread_id，从最新 Checkpoint 继续未完成的 Node。 */
async function resumeWorkflow(graph, config) {
	console.log('========== 新进程：恢复制作流程 ==========')
	const beforeResume = await graph.getState(config)

	if (!beforeResume.values.presentationId) {
		console.log('没有找到待恢复的工作流，请先执行 npm run start。')
		return
	}

	console.log(`恢复前待执行 Node：${beforeResume.next.join(', ') || '无'}`)
	const result = await graph.invoke(null, config)

	console.log('\n流程恢复完成：')
	console.log(
		JSON.stringify(
			{
				draftSaved: result.draftSaved,
				executionPath: result.executionPath
			},
			null,
			2
		)
	)
}

/** 连接持久化存储，并根据命令执行一次独立的课程实验。 */
async function main() {
	// 使用 PostgreSQL 创建 LangGraph Checkpointer，
	// 用于持久化工作流状态，使任务可以跨进程暂停和恢复。
	const checkpointer = PostgresSaver.fromConnString(getPostgresUri())

	// 创建本次工作流运行配置，其中包含固定的 thread_id 等信息。
	const config = createConfig()

	try {
		// 初始化 Checkpointer 所需的数据库表。
		await checkpointer.setup()

		// reset 模式：删除当前 Thread 保存的所有工作流状态。
		if (mode === 'reset') {
			await checkpointer.deleteThread(threadId)
			console.log(`已清理工作流：${threadId}`)
			return
		}

		// 创建演示文稿工作流。
		// start 模式下主动让保存步骤失败，用来模拟任务执行中断，
		// 后续可以通过 resume 模式验证 Checkpoint 恢复能力。
		const graph = createPresentationWorkflow({
			checkpointer,
			shouldFailSave: () => mode === 'start'
		})

		// start：从头启动工作流。
		if (mode === 'start') {
			await startWorkflow(graph, config)
			return
		}

		// status：读取 Checkpoint，查看当前工作流保存的状态。
		if (mode === 'status') {
			await showWorkflowStatus(graph, config)
			return
		}

		// 其他情况默认按照 resume 处理，
		// 从之前保存的 Checkpoint 继续执行未完成的工作流。
		await resumeWorkflow(graph, config)
	} finally {
		// 无论执行成功还是发生异常，都关闭 PostgreSQL 连接。
		await checkpointer.end()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
