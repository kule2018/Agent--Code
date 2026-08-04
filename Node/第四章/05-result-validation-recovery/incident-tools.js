const { incident } = require('./incident-data')

class ToolExecutionError extends Error {
	constructor(code, message, details = {}) {
		super(message)
		this.name = 'ToolExecutionError'
		this.code = code
		this.details = details
	}
}

/**
 * 为指定实验创建工具执行器。
 *
 * 工具行为由场景固定，方便所有同学稳定复现超时、空结果和证据冲突。
 *
 * @param {string} scenarioName 实验名称
 * @returns {Function} 工具执行函数
 */
function createToolExecutor(scenarioName) {
	const attempts = new Map()

	return async function executeTool(action) {
		const attempt = (attempts.get(action.toolName) || 0) + 1
		attempts.set(action.toolName, attempt)

		if (action.arguments.serviceName !== incident.serviceName) {
			throw new ToolExecutionError(
				'INVALID_ARGUMENT',
				`没有找到服务 ${action.arguments.serviceName}`
			)
		}

		switch (action.toolName) {
			case 'query_primary_logs':
				return queryPrimaryLogs(scenarioName, attempt)
			case 'query_backup_logs':
				return queryBackupLogs()
			case 'query_traces':
				return queryTraces()
			case 'query_instance_inventory':
				return queryInstanceInventory()
			default:
				throw new ToolExecutionError(
					'TOOL_NOT_FOUND',
					`不存在工具 ${action.toolName}`
				)
		}
	}
}

function queryPrimaryLogs(scenarioName, attempt) {
	if (scenarioName === 'retry-fallback') {
		throw new ToolExecutionError(
			'UPSTREAM_TIMEOUT',
			`主日志服务第 ${attempt} 次请求超时。`,
			{ retryable: true }
		)
	}

	if (scenarioName === 'replan') {
		return createObservation('primary_logs', {
			records: [],
			summary: '主日志服务请求成功，但目标时间段内没有查到匹配记录。'
		})
	}

	return createObservation('primary_logs', {
		records: [incident.primaryLogs],
		runtimeVersion: incident.primaryLogs.runtimeVersion,
		summary:
			'日志显示报错实例运行 v2.4.1，错误码为 PAYMENT_CURRENCY_UNDEFINED。'
	})
}

function queryBackupLogs() {
	return createObservation('backup_logs', {
		records: [incident.primaryLogs],
		runtimeVersion: incident.primaryLogs.runtimeVersion,
		summary:
			'备用日志索引找到报错记录，运行版本为 v2.4.1。'
	})
}

function queryTraces() {
	return createObservation('traces', {
		records: [incident.traceEvidence],
		summary:
			'调用链追踪显示 normalizeCurrency 是第一个失败节点。'
	})
}

function queryInstanceInventory() {
	return createObservation('instance_inventory', {
		records: [incident.inventory],
		activeVersion: incident.inventory.activeVersion,
		summary: '实例清单显示 payment-service 当前运行版本为 v2.4.0。'
	})
}

function createObservation(source, data) {
	return {
		ok: true,
		source,
		evidenceKey: `${source}:${incident.serviceName}`,
		data
	}
}

module.exports = {
	ToolExecutionError,
	createToolExecutor
}
