const { hasTool } = require('./incident-tools')

const STEP_STATUS = {
	PENDING: 'pending',
	RUNNING: 'running',
	COMPLETED: 'completed',
	CANCELLED: 'cancelled'
}

/**
 * 根据 Planner 返回结果创建应用程序持有的 Plan State。
 *
 * @param {string} goal 用户目标
 * @param {Array<string>} completionCriteria 任务完成条件
 * @param {object} initialPlan Planner 返回的初始计划
 * @returns {object} 可持续更新的计划状态
 */
function createPlanState(goal, completionCriteria, initialPlan) {
	const state = {
		goal,
		version: 1,
		status: 'active',
		planSummary: initialPlan.planSummary,
		completionCriteria,
		steps: initialPlan.steps.map((step) => ({
			...step,
			status: STEP_STATUS.PENDING,
			observation: null
		})),
		revisions: []
	}

	// 检查计划完整性，确保没有重复 ID、依赖关系正确、工具存在等
	assertPlanIntegrity(state)

	return state
}

/**
 * 找到当前依赖已经完成的第一个待执行步骤。
 *
 * @param {object} state 当前计划状态
 * @returns {object|null} 下一步，找不到时返回 null
 */
function getNextReadyStep(state) {
	const completedStepIds = new Set(
		state.steps
			.filter((step) => step.status === STEP_STATUS.COMPLETED)
			.map((step) => step.id)
	)

	return (
		state.steps.find(
			(step) =>
				step.status === STEP_STATUS.PENDING &&
				step.dependsOn.every((stepId) => completedStepIds.has(stepId))
		) || null
	)
}

/**
 * 把计划步骤标记为执行中。
 *
 * @param {object} state 当前计划状态
 * @param {string} stepId 步骤 ID
 */
function startStep(state, stepId) {
	const step = getStep(state, stepId)

	if (step.status !== STEP_STATUS.PENDING) {
		throw new Error(`步骤 ${stepId} 当前不是 pending，不能开始执行。`)
	}

	step.status = STEP_STATUS.RUNNING
}

/**
 * 保存工具 Observation，并把步骤标记为完成。
 *
 * @param {object} state 当前计划状态
 * @param {string} stepId 步骤 ID
 * @param {object} observation 工具结果
 */
function completeStep(state, stepId, observation) {
	const step = getStep(state, stepId)

	if (step.status !== STEP_STATUS.RUNNING) {
		throw new Error(`步骤 ${stepId} 当前不是 running，不能完成。`)
	}

	step.status = STEP_STATUS.COMPLETED
	step.observation = observation
}

/**
 * 将 Replanner 的决定合并到当前计划。
 *
 * 已完成步骤不会被删除；只能取消尚未执行的步骤，
 * 再把新的待执行步骤加入计划。
 *
 * @param {object} state 当前计划状态
 * @param {object} decision Replanner 返回结果
 */
function applyReplan(state, decision) {
	const previousVersion = state.version

	if (decision.decision === 'finish' && decision.newSteps.length > 0) {
		throw new Error('Replanner 决定 finish 时不能继续增加新步骤。')
	}

	for (const stepId of decision.cancelStepIds) {
		const step = getStep(state, stepId)

		if (step.status !== STEP_STATUS.PENDING) {
			throw new Error(
				`只能取消 pending 步骤，${stepId} 当前为 ${step.status}。`
			)
		}

		step.status = STEP_STATUS.CANCELLED
	}

	const activeStepSignatures = new Set(
		state.steps
			.filter((step) => step.status !== STEP_STATUS.CANCELLED)
			.map(createStepSignature)
	)

	const newStepsToAdd = decision.newSteps.filter((step) => {
		const signature = createStepSignature(step)

		if (activeStepSignatures.has(signature)) {
			return false
		}

		activeStepSignatures.add(signature)
		return true
	})

	for (const step of newStepsToAdd) {
		state.steps.push({
			...step,
			status: STEP_STATUS.PENDING,
			observation: null
		})
	}

	const remainingPendingSteps = state.steps.filter(
		(step) => step.status === STEP_STATUS.PENDING
	)

	if (decision.decision === 'finish' && remainingPendingSteps.length > 0) {
		throw new Error(
			`Replanner 决定 finish，但计划中仍有 pending 步骤：${remainingPendingSteps
				.map((step) => step.id)
				.join('、')}`
		)
	}

	const completedStepCount = state.steps.filter(
		(step) => step.status === STEP_STATUS.COMPLETED
	).length

	if (
		decision.decision === 'finish' &&
		completedStepCount < state.completionCriteria.length
	) {
		throw new Error(
			`Replanner 过早结束任务：当前只有 ${completedStepCount} 份已完成结果，无法覆盖 ${state.completionCriteria.length} 条完成条件。`
		)
	}

	state.version += 1
	state.status = decision.decision === 'finish' ? 'ready_to_finish' : 'active'
	state.planSummary = decision.planSummary
	state.revisions.push({
		fromVersion: previousVersion,
		toVersion: state.version,
		decision: decision.decision,
		reason: decision.reason,
		cancelStepIds: decision.cancelStepIds,
		newStepIds: newStepsToAdd.map((step) => step.id)
	})

	assertPlanIntegrity(state)
}

/**
 * 读取已经完成步骤形成的证据。
 *
 * @param {object} state 当前计划状态
 * @returns {Array<object>} 已完成步骤及 Observation
 */
function getCompletedEvidence(state) {
	return state.steps
		.filter((step) => step.status === STEP_STATUS.COMPLETED)
		.map((step) => ({
			id: step.id,
			title: step.title,
			toolName: step.toolName,
			observation: step.observation
		}))
}

/**
 * 检查计划 ID、工具和依赖关系。
 *
 * @param {object} state 当前计划状态
 */
function assertPlanIntegrity(state) {
	const ids = state.steps.map((step) => step.id)
	const idSet = new Set(ids)

	if (idSet.size !== ids.length) {
		throw new Error('计划中出现了重复的步骤 ID。')
	}

	for (const step of state.steps) {
		if (!hasTool(step.toolName)) {
			throw new Error(`计划引用了不存在的工具 ${step.toolName}。`)
		}

		for (const dependencyId of step.dependsOn) {
			if (!idSet.has(dependencyId)) {
				throw new Error(`步骤 ${step.id} 依赖不存在的步骤 ${dependencyId}。`)
			}

			if (dependencyId === step.id) {
				throw new Error(`步骤 ${step.id} 不能依赖自己。`)
			}
		}
	}
}

function getStep(state, stepId) {
	const step = state.steps.find((item) => item.id === stepId)

	if (!step) {
		throw new Error(`计划中不存在步骤 ${stepId}。`)
	}

	return step
}

/**
 * 使用工具名称和参数识别重复计划步骤。
 *
 * @param {object} step 计划步骤
 * @returns {string} 可比较的步骤签名
 */
function createStepSignature(step) {
	return `${step.toolName}:${JSON.stringify(step.arguments)}`
}

module.exports = {
	STEP_STATUS,
	createPlanState,
	getNextReadyStep,
	startStep,
	completeStep,
	applyReplan,
	getCompletedEvidence
}
