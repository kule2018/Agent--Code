/**
 * 根据失败类型和当前执行语境选择恢复策略。
 *
 * 这些分类和路由是当前教学项目定义的工程规则，
 * 并不是某个 Agent 协议规定的固定枚举。
 *
 * @param {object} input 恢复决策所需数据
 * @returns {object} 恢复决定
 */
function selectRecovery({ failure, action, retryCount }) {
	const recovery = action?.recovery || {}

	if (
		failure.kind === 'transient_error' &&
		retryCount < (recovery.maxRetries || 0)
	) {
		return {
			strategy: 'retry',
			delayMs: calculateBackoffMs(recovery.retryDelayMs || 20, retryCount)
		}
	}

	if (failure.kind === 'transient_error' && recovery.fallbackAction) {
		return {
			strategy: 'fallback',
			nextAction: clone(recovery.fallbackAction)
		}
	}

	if (failure.kind === 'no_evidence' && recovery.replanAction) {
		return {
			strategy: 'replan',
			replacementStep: {
				id: `${action.toolName}-replacement`,
				title: recovery.replanTitle,
				action: clone(recovery.replanAction),
				status: 'pending'
			}
		}
	}

	return {
		strategy: 'human_handoff',
		reason: failure
	}
}

function calculateBackoffMs(initialDelayMs, retryCount) {
	return initialDelayMs * 2 ** retryCount
}

function clone(value) {
	return JSON.parse(JSON.stringify(value))
}

module.exports = {
	selectRecovery,
	calculateBackoffMs
}
