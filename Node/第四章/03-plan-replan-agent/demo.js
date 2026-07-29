const { incident } = require('./incident-data')
const { toolCatalog, executeTool } = require('./incident-tools')
const { runPlanAgent } = require('./plan-agent')

/**
 * 任务目标
 */
const goal =
	'排查 payment-service 从 15:10 开始出现的大量支付失败，找出最可能原因并给出处理建议。不要执行重启或回滚。'

/**
 * 完成条件
 */
const completionCriteria = [
	'通过监控数据确认故障现象和异常时间',
	'通过错误日志找到直接故障表现',
	'使用另一份独立系统数据验证最可能的故障原因'
]

/**
 * 启动故障排查 Agent。
 *
 * runPlanAgent 会完成以下工作：
 * 1. 根据 goal 和 completionCriteria 生成初始排查计划；
 * 2. 从 toolCatalog 中选择合适的工具；
 * 3. 通过 executeTool 执行工具；
 * 4. 根据工具返回的 Observation 调整后续计划；
 * 5. 满足完成标准后，输出故障原因和处理建议。
 */
async function main() {
	await runPlanAgent({
		// Agent 最终需要完成的任务。
		goal,

		// 当前事故的告警上下文，为 Agent 提供初始故障信息。
		alertContext: incident.alertContext,

		// 判断任务是否完成的验收条件。
		completionCriteria,

		// Agent 可以发现和选择的工具定义。
		toolCatalog,

		// 工具的统一执行入口。
		executeTool
	})
}

main().catch((error) => {
	console.error('\n运行失败：', error instanceof Error ? error.message : error)
	process.exitCode = 1
})
