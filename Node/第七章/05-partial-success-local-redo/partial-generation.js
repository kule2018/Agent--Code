import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { createPartialGenerationWorkflow } from './workflow.js'

const mode = process.argv[2]
const supportedModes = new Set([
	'reset',
	'start',
	'status',
	'continue',
	'revise-page',
	'outline-v2',
	'export'
])
const threadId = 'presentation-partial-generation-1001'

if (!supportedModes.has(mode)) {
	throw new Error(
		'请通过 npm run reset、start、status、continue、revise:page、outline:v2 或 export 运行案例。'
	)
}

/** 获取课程案例使用的 PostgreSQL 连接地址。 */
function getPostgresUri() {
	return (
		process.env.POSTGRES_URI ??
		'postgresql://agent_course:agent_course@localhost:5435/agent_partial_generation'
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

/** 用更容易观察的格式打印页面任务和产物。 */
function printStatus(snapshot) {
	const values = snapshot.values

	console.log(`\n演示文稿：${values.presentationId}`)
	console.log(`当前大纲：Outline v${values.outlineVersion}`)
	console.log(`任务状态：${values.runStatus}`)
	console.log('\n页面任务：')

	for (const task of values.pageTasks ?? []) {
		console.log(
			`- [${task.status}] ${task.pageId} ${task.title} | Outline v${task.outlineVersion} | 页面 r${task.pageRevision} | 尝试 ${task.attempts} 次`
		)
		if (task.currentArtifactId) {
			console.log(`  当前产物：${task.currentArtifactId}`)
		}
		if (task.lastError) {
			console.log(`  原因：${task.lastError}`)
		}
	}

	console.log(`\n已保存产物：${values.artifacts?.length ?? 0} 个`)
	if (values.exportResult) {
		console.log('\n导出校验：')
		console.log(JSON.stringify(values.exportResult, null, 2))
	}
}

/** 读取已经保存的完整 State，并开始一轮新的操作。 */
async function invokeExisting(graph, config, operation, extra = {}) {
	const snapshot = await graph.getState(config)

	if (!snapshot.values.presentationId) {
		throw new Error('没有找到页面制作任务，请先执行 npm run start。')
	}

	return graph.invoke(
		{
			...snapshot.values,
			operation,
			targetPageId: null,
			changeRequest: null,
			...extra
		},
		config
	)
}

/** 第一次生成全部页面，其中第三页会模拟失败。 */
async function startWorkflow(graph, config) {
	console.log('========== 第一次生成全部页面 ==========')
	await graph.invoke(
		{
			presentationId: 'PRESENTATION-1001',
			operation: 'initial'
		},
		config
	)
	printStatus(await graph.getState(config))
}

/** 只继续失败、缺失或者已经失效的页面。 */
async function continueWorkflow(graph, config) {
	console.log('========== 继续未完成页面 ==========')
	await invokeExisting(graph, config, 'continue')
	printStatus(await graph.getState(config))
}

/** 只修改第二页，并保留其他页面当前产物。 */
async function reviseSinglePage(graph, config) {
	console.log('========== 只修改 page-2 ==========')
	await invokeExisting(graph, config, 'revise_page', {
		targetPageId: 'page-2',
		changeRequest: '突出 Agent 的风险控制与人工审核能力。'
	})
	printStatus(await graph.getState(config))
}

/** 发布新版大纲，让上一版本生成的页面统一失效。 */
async function publishOutlineV2(graph, config) {
	console.log('========== 发布 Outline v2 ==========')
	await invokeExisting(graph, config, 'publish_outline')
	printStatus(await graph.getState(config))
}

/** 导出以前校验页面产物是否完整且版本一致。 */
async function exportPresentation(graph, config) {
	console.log('========== 校验并导出演示文稿 ==========')
	await invokeExisting(graph, config, 'export')
	printStatus(await graph.getState(config))
}

/** 连接持久化存储，并执行一次独立操作。 */
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

		const graph = createPartialGenerationWorkflow({ checkpointer })

		if (mode === 'start') {
			await startWorkflow(graph, config)
			return
		}

		if (mode === 'status') {
			printStatus(await graph.getState(config))
			return
		}

		if (mode === 'continue') {
			await continueWorkflow(graph, config)
			return
		}

		if (mode === 'revise-page') {
			await reviseSinglePage(graph, config)
			return
		}

		if (mode === 'outline-v2') {
			await publishOutlineV2(graph, config)
			return
		}

		await exportPresentation(graph, config)
	} finally {
		await checkpointer.end()
	}
}

main().catch((error) => {
	console.error(`执行失败：${error.message}`)
	process.exitCode = 1
})
