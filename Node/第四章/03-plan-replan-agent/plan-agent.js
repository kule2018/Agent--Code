const { MODEL, callDeepSeek } = require('./deepseek-client')
const {
	createPlanState,
	getNextReadyStep,
	startStep,
	completeStep,
	applyReplan,
	getCompletedEvidence
} = require('./plan-state')
const { createInitialPlan, replan } = require('./planner')

const MAX_EXECUTED_STEPS = 6

/**
 * 运行具备显式计划和重新规划能力的故障排查 Agent。
 *
 * @param {object} input 运行参数
 * @param {string} input.goal 用户目标
 * @param {object} input.alertContext 初始告警
 * @param {Array<string>} input.completionCriteria 任务完成条件
 * @param {Array} input.toolCatalog 可用工具
 * @param {Function} input.executeTool 工具执行函数
 * @returns {Promise<object>} 最终回答和 Plan State
 */
async function runPlanAgent({
	goal,
	alertContext,
	completionCriteria,
	toolCatalog,
	executeTool
}) {
	console.log(`模型：${MODEL}`)
	console.log(`目标：${goal}`)
	console.log(`初始告警：${alertContext.summary}`)

	// 创建初始计划和状态
	const initialResult = await createInitialPlan({
		goal,
		alertContext,
		completionCriteria,
		toolCatalog
	})

	// 创建应用程序持有的 Plan State
	const state = createPlanState(goal, completionCriteria, initialResult.plan)

	console.log(`\nPlanner：${initialResult.latencyMs}ms`)
	printPlan(state)

	// 运行循环，直到满足完成条件或达到最大执行次数
	let executedSteps = 0

	// 循环执行计划步骤，直到满足完成条件或达到最大执行次数
	while (state.status === 'active') {
		if (executedSteps >= MAX_EXECUTED_STEPS) {
			throw new Error(
				`达到最大工具执行次数 ${MAX_EXECUTED_STEPS}，任务仍未满足结束条件。`
			)
		}

		// 找到当前依赖已经完成的第一个待执行步骤
		const nextStep = getNextReadyStep(state)

		if (!nextStep) {
			throw new Error('当前仍有未完成任务，但没有依赖已满足的可执行步骤。')
		}

		// 把计划步骤标记为执行中
		startStep(state, nextStep.id)

		console.log(`\n================ 执行 ${nextStep.id} ================`)
		console.log(`目标：${nextStep.title}`)
		console.log(`工具：${nextStep.toolName}`)

		// 执行工具，获取 Observation
		const observation = await executeTool(nextStep.toolName, nextStep.arguments)

		// 把计划步骤标记为已完成，并记录 Observation
		completeStep(state, nextStep.id, observation)
		executedSteps += 1

		console.log('Observation：')
		console.dir(observation, { depth: null })

		// 根据最新 Observation 重新检查计划
		const replanResult = await replan({
			state,
			toolCatalog
		})

		console.log(`\nReplanner：${replanResult.latencyMs}ms`)
		console.log(`决定：${replanResult.decision.decision}`)
		console.log(`原因：${replanResult.decision.reason}`)

		// 根据 Replanner 的决定更新计划状态
		applyReplan(state, replanResult.decision)
		printPlan(state)
	}

	// 使用已完成步骤的 Observation 生成最终结论
	const finalAnswer = await generateFinalAnswer({
		goal,
		evidence: getCompletedEvidence(state)
	})

	state.status = 'completed'

	console.log('\n================ 最终结论 ================')
	console.log(finalAnswer)

	return {
		finalAnswer,
		state
	}
}

/**
 * 只使用已完成步骤的 Observation 生成最终结论。
 *
 * @param {object} input 结论输入
 * @param {string} input.goal 用户目标
 * @param {Array} input.evidence 已完成步骤形成的证据
 * @returns {Promise<string>} 最终回答
 */
async function generateFinalAnswer({ goal, evidence }) {
	const result = await callDeepSeek({
		messages: [
			{
				role: 'system',
				content: `你是线上故障排查 Agent。
只能根据应用程序提供的已完成步骤和 Observation 生成结论。
回答必须包含：最可能原因、关键证据、建议动作和仍未确认的信息。
当前没有写操作工具，不得声称已经回滚、重启或修复。`
			},
			{
				role: 'user',
				content: `用户目标：
${goal}

已完成步骤与证据：
${JSON.stringify(evidence, null, 2)}`
			}
		],
		maxTokens: 1600
	})

	return result.message.content
}

/**
 * 打印当前计划，让每次 Replan 的变化可以直接被观察。
 *
 * @param {object} state 当前计划状态
 */
function printPlan(state) {
	console.log(`\nPlan v${state.version}：${state.planSummary}`)

	if (state.version === 1) {
		console.log('完成条件：')

		for (const criterion of state.completionCriteria) {
			console.log(`- ${criterion}`)
		}
	}

	for (const step of state.steps) {
		console.log(
			`[${step.status.padEnd(9)}] ${step.id} ${step.title} -> ${step.toolName}`
		)
	}
}

module.exports = {
	runPlanAgent
}
