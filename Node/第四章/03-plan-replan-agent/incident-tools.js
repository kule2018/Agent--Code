const { z } = require('zod')

const { incident } = require('./incident-data')

const serviceArgumentsSchema = z.object({
	serviceName: z.string().min(1)
})

const toolCatalog = [
	{
		name: 'query_metrics',
		description:
			'查询错误率、延迟、CPU、内存和数据库连接池使用率。适合先判断异常集中在哪个方向。'
	},
	{
		name: 'inspect_database_pool',
		description:
			'检查数据库连接池的活跃连接、等待请求和获取连接延迟。只有证据仍然指向数据库时使用。'
	},
	{
		name: 'query_logs',
		description:
			'查询主要错误、首次出现时间和服务版本。适合在指标不能解释故障时继续定位错误来源。'
	},
	{
		name: 'get_recent_deployments',
		description:
			'查询最近发布的版本、完成时间和变更内容。只有日志或时间线指向版本变化时使用。'
	}
]

const toolRegistry = {
	query_metrics: () => incident.metrics,
	inspect_database_pool: () => incident.databasePool,
	query_logs: () => incident.logs,
	get_recent_deployments: () => incident.deployments
}

/**
 * 执行计划步骤中声明的工具。
 *
 * @param {string} toolName 工具名称
 * @param {object} rawArguments 工具参数
 * @returns {Promise<object>} 工具返回的 Observation
 */
async function executeTool(toolName, rawArguments) {
	const execute = toolRegistry[toolName]

	if (!execute) {
		throw new Error(`不存在工具 ${toolName}`)
	}

	const argumentsResult = serviceArgumentsSchema.safeParse(rawArguments)

	if (!argumentsResult.success) {
		throw new Error(`工具 ${toolName} 的参数没有通过校验。`)
	}

	if (argumentsResult.data.serviceName !== incident.serviceName) {
		throw new Error(`没有找到服务 ${argumentsResult.data.serviceName}`)
	}

	return {
		ok: true,
		source: toolName,
		data: execute()
	}
}

/**
 * 判断 Planner 返回的工具是否属于当前允许范围。
 *
 * @param {string} toolName 工具名称
 * @returns {boolean} 是否存在
 */
function hasTool(toolName) {
	return Object.hasOwn(toolRegistry, toolName)
}

module.exports = {
	toolCatalog,
	executeTool,
	hasTool
}

