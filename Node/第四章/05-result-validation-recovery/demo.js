const { runRecoveryAgent } = require('./recovery-runtime')

/**
 * 实验场景列表
 * - replan：工具调用成功，但返回空结果，触发重新规划
 * - handoff：不同数据源返回的有效证据相互冲突，触发人工接管
 * - retry-fallback：工具调用超时，先重试，仍失败则切换备用方案
 */
const SCENARIOS = ['replan', 'handoff', 'retry-fallback']

async function main() {
	const selectedScenario = process.argv[2]
	const scenarios = selectedScenario ? [selectedScenario] : SCENARIOS

	for (const scenarioName of scenarios) {
		if (!SCENARIOS.includes(scenarioName)) {
			throw new Error(
				`未知实验 ${scenarioName}，可选值：${SCENARIOS.join('、')}`
			)
		}

		console.log(
			`\n\n================ ${getTitle(scenarioName)} ================`
		)
		// 运行恢复代理
		const state = await runRecoveryAgent({ scenarioName })
		printSummary(state)
	}
}

function printSummary(state) {
	console.log('\nRun 结束：')
	console.log(`status = ${state.status}`)
	console.log(`stopReason = ${state.stopReason.code}`)
	console.log(
		`recoveryStrategies = ${JSON.stringify(
			state.recoveryEvents.map((item) => item.strategy)
		)}`
	)
	console.log(`planVersion = ${state.planState.version}`)
	console.log(
		`planSteps = ${JSON.stringify(
			state.planState.steps.map((step) => ({
				id: step.id,
				status: step.status,
				toolName: step.action.toolName,
				resolvedBy: step.resolvedBy || null
			}))
		)}`
	)
	console.log(`usage = ${JSON.stringify(state.usage)}`)

	if (state.handoff) {
		console.log('handoff =')
		console.dir(state.handoff, { depth: null })
	}
}

function getTitle(scenarioName) {
	const titles = {
		replan: '实验一：空结果被校验器拒绝',
		handoff: '实验二：证据冲突后暂停运行',
		'retry-fallback': '实验三：工具异常后的 Retry 与 Fallback'
	}

	return titles[scenarioName]
}

main().catch((error) => {
	console.error('\n运行失败：', error instanceof Error ? error.message : error)
	process.exitCode = 1
})
