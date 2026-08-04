const assert = require('node:assert/strict')
const { runRecoveryAgent } = require('./recovery-runtime')

async function main() {
	const retryFallback = await runRecoveryAgent({
		scenarioName: 'retry-fallback',
		silent: true
	})
	assert.equal(retryFallback.status, 'completed')
	assert.deepEqual(
		retryFallback.recoveryEvents.map((item) => item.strategy),
		['retry', 'fallback']
	)
	assert.equal(retryFallback.usage.toolAttempts, 3)
	assert.equal(retryFallback.usage.toolResponses, 1)
	assert.equal(retryFallback.usage.validatedObservations, 1)
	assert.equal(retryFallback.planState.steps[0].resolvedBy, 'query_backup_logs')

	const replan = await runRecoveryAgent({
		scenarioName: 'replan',
		silent: true
	})
	assert.equal(replan.status, 'completed')
	assert.equal(replan.planState.version, 2)
	assert.equal(replan.usage.toolResponses, 2)
	assert.equal(replan.usage.validatedObservations, 1)
	assert.deepEqual(
		replan.planState.steps.map((step) => step.status),
		['cancelled', 'completed']
	)

	const handoff = await runRecoveryAgent({
		scenarioName: 'handoff',
		silent: true
	})
	assert.equal(handoff.status, 'waiting_for_human')
	assert.equal(handoff.stopReason.code, 'human_handoff')
	assert.equal(handoff.handoff.reasonCode, 'RUNTIME_VERSION_CONFLICT')
	assert.equal(handoff.handoff.evidenceKeys.length, 2)

	console.log('三组结果校验与失败恢复实验验证通过。')
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
