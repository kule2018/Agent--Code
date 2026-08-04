const { randomUUID } = require('node:crypto')

/**
 * 创建本节使用的 Agent Run State。
 *
 * @param {string} scenarioName 当前实验名称
 * @returns {object} 初始运行状态
 */
function createRecoveryState(scenarioName) {
	return {
		runId: randomUUID(),
		scenarioName,
		status: 'running',
		stopReason: null,
		planState: createPlanState(scenarioName),
		observations: [],
		recoveryEvents: [],
		usage: {
			toolAttempts: 0,
			toolResponses: 0,
			validatedObservations: 0
		},
		handoff: null,
		trace: []
	}
}

function createPlanState(scenarioName) {
	const serviceArguments = { serviceName: 'payment-service' }

	if (scenarioName === 'retry-fallback') {
		return {
			version: 1,
			status: 'active',
			steps: [
				{
					id: 'collect-logs',
					title: '收集错误日志',
					status: 'pending',
					action: {
						toolName: 'query_primary_logs',
						arguments: serviceArguments,
						recovery: {
							maxRetries: 1,
							retryDelayMs: 20,
							fallbackAction: {
								toolName: 'query_backup_logs',
								arguments: serviceArguments
							}
						}
					}
				}
			]
		}
	}

	if (scenarioName === 'replan') {
		return {
			version: 1,
			status: 'active',
			steps: [
				{
					id: 'locate-failure',
					title: '从日志中定位直接故障',
					status: 'pending',
					action: {
						toolName: 'query_primary_logs',
						arguments: serviceArguments,
						recovery: {
							replanTitle: '改用调用链追踪定位失败节点',
							replanAction: {
								toolName: 'query_traces',
								arguments: serviceArguments
							}
						}
					}
				}
			]
		}
	}

	if (scenarioName === 'handoff') {
		return {
			version: 1,
			status: 'active',
			steps: [
				{
					id: 'collect-logs',
					title: '查询报错实例的日志版本',
					status: 'pending',
					action: {
						toolName: 'query_primary_logs',
						arguments: serviceArguments
					}
				},
				{
					id: 'check-inventory',
					title: '查询服务实例的当前版本',
					status: 'pending',
					action: {
						toolName: 'query_instance_inventory',
						arguments: serviceArguments
					}
				}
			]
		}
	}

	throw new Error(`不存在实验 ${scenarioName}`)
}

module.exports = {
	createRecoveryState
}
