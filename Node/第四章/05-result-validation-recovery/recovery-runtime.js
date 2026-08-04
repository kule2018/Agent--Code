const { createToolExecutor } = require('./incident-tools')
const {
	validateObservation,
	validateEvidenceSet,
	classifyToolError
} = require('./result-validator')
const { selectRecovery } = require('./recovery-policy')
const { createRecoveryState } = require('./recovery-state')

/**
 * 运行一次带结果校验和失败恢复的 Agent 任务。
 *
 * @param {object} input 运行参数
 * @param {string} input.scenarioName 实验名称
 * @param {boolean} [input.silent] 是否关闭运行日志
 * @returns {Promise<object>} 结束后的 Agent Run State
 */
async function runRecoveryAgent({ scenarioName, silent = false }) {
	// 为当前实验创建独立的运行状态
	const state = createRecoveryState(scenarioName)

	// 根据实验场景创建对应的工具执行器，用于模拟空结果、冲突或超时
	const executeTool = createToolExecutor(scenarioName)

	// 根据 silent 参数决定是否输出运行日志
	const log = createLogger(silent)

	log(`runId：${state.runId}`)

	// 只要任务仍处于运行状态，就持续调度待执行的计划步骤
	while (state.status === 'running') {
		// 当前示例按顺序获取第一个尚未处理的步骤
		const step = state.planState.steps.find((item) => item.status === 'pending')

		// 没有待执行步骤时，检查计划是否满足完成条件并结束运行
		if (!step) {
			completeRun(state)
			break
		}

		log(`\n执行步骤：${step.title}`)
		log(`Action：${formatAction(step.action)}`)

		// 执行当前 Action，并在内部完成结果校验、重试或备用方案选择
		const result = await executeActionWithRecovery({
			state,
			step,
			executeTool,
			log
		})

		// 工具返回了通过校验的有效 Observation
		if (result.type === 'observation') {
			// 标记当前计划步骤已完成，并记录最终使用的工具
			step.status = 'completed'
			step.resolvedBy = result.action.toolName

			// 保存有效 Observation 及相关运行统计
			state.usage.validatedObservations += 1
			state.observations.push(result.observation)
			state.trace.push({
				type: 'observation',
				stepId: step.id,
				evidenceKey: result.observation.evidenceKey
			})

			log(`校验通过：${result.observation.data.summary}`)

			// 单条结果有效，并不代表全部证据组合后仍然一致
			const evidenceValidation = validateEvidenceSet(state.observations)

			// 多份证据发生冲突时，记录恢复决策并转交人工处理
			if (!evidenceValidation.ok) {
				const decision = selectRecovery({
					failure: evidenceValidation.failure,
					action: step.action,
					retryCount: 0
				})

				// 把证据冲突和恢复决策写入运行状态及执行日志
				recordRecovery(state, decision, evidenceValidation.failure, log)
				// 当前证据冲突无法自动恢复时，转交人工处理
				applyHumanHandoff(state, evidenceValidation.failure)
			}

			// 当前步骤处理完成，进入下一轮计划调度
			continue
		}

		// 当前 Action 无法获得有效结果，需要替换原计划步骤
		if (result.type === 'replan') {
			// 取消原步骤，并递增 Plan State 版本
			step.status = 'cancelled'
			state.planState.version += 1

			// 将重新规划得到的替代步骤追加到计划中
			state.planState.steps.push(result.replacementStep)
			continue
		}

		// 无法通过重试、备用工具或重新规划恢复时，转交人工处理
		applyHumanHandoff(state, result.failure)
	}

	// 返回完整运行状态，供日志汇总、测试断言或后续分析使用
	return state
}

/**
 * 执行一个 Action，并在执行失败或结果校验失败时尝试恢复。
 *
 * 恢复策略可能包括：
 * - retry：等待一段时间后重试当前 Action
 * - fallback：切换到备用 Action 后继续执行
 * - replan：返回替代步骤，由上层更新 Plan State
 * - human_handoff：无法自动恢复，转交人工处理
 *
 * @param {object} input 执行参数
 * @param {object} input.state 当前 Agent Run State
 * @param {object} input.step 当前计划步骤
 * @param {Function} input.executeTool 工具执行函数
 * @param {Function} input.log 日志输出函数
 * @returns {Promise<object>} Action 的最终执行结果
 */
async function executeActionWithRecovery({ state, step, executeTool, log }) {
	// 克隆步骤中的原始 Action，避免切换备用 Action 时直接修改 Plan State
	let action = clone(step.action)

	// 记录当前 Action 已经连续重试的次数
	let retryCount = 0

	// Runtime 仍处于运行状态时，持续执行或恢复当前 Action
	while (state.status === 'running') {
		// 每次调用工具都计为一次尝试，包括重试和备用工具调用
		state.usage.toolAttempts += 1

		try {
			// 执行当前 Action 对应的工具
			const observation = await executeTool(action)

			// 工具正常返回时，记录一次工具响应
			state.usage.toolResponses += 1

			// 校验 Observation 是否满足当前 Action 的结果要求
			const validation = validateObservation(action, observation)

			// Observation 有效时，将结果交给上层写入 Agent Run State
			if (validation.ok) {
				return { type: 'observation', observation, action }
			}

			// 工具虽然正常返回，但结果为空、格式错误或不满足业务要求
			log(`结果校验失败：${validation.failure.message}`)

			// 根据失败类型、当前 Action 和重试次数选择恢复策略
			const decision = selectRecovery({
				failure: validation.failure,
				action,
				retryCount
			})

			// 把本次失败和恢复决策写入运行状态及执行日志
			recordRecovery(state, decision, validation.failure, log)

			// 当前数据源无法提供有效结果时，返回替代步骤并触发重新规划
			if (decision.strategy === 'replan') {
				return {
					type: 'replan',
					replacementStep: decision.replacementStep
				}
			}

			// 结果校验失败且无法自动恢复时，转交人工处理
			return { type: 'human_handoff', failure: validation.failure }
		} catch (error) {
			// 将工具抛出的原始异常转换成统一的 Failure 结构
			const failure = classifyToolError(error)

			log(`工具执行失败：${failure.message}`)

			// 根据异常类型选择重试、备用方案或人工接管
			const decision = selectRecovery({ failure, action, retryCount })

			// 记录本次异常及对应的恢复决策
			recordRecovery(state, decision, failure, log)

			// 临时故障允许重试时，等待指定时间后再次执行当前 Action
			if (decision.strategy === 'retry') {
				retryCount += 1
				await delay(decision.delayMs)
				continue
			}

			// 当前工具持续失败时，切换到备用工具或备用数据源
			if (decision.strategy === 'fallback') {
				action = decision.nextAction

				// 新 Action 使用独立的重试计数
				retryCount = 0

				log(`切换 Action：${formatAction(action)}`)
				continue
			}

			// 不满足重试或备用方案条件时，交由人工处理
			return { type: 'human_handoff', failure }
		}
	}

	// Runtime 在恢复过程中被外部停止时，返回统一的人工接管结果
	return {
		type: 'human_handoff',
		failure: {
			kind: 'runtime_stopped',
			code: 'RUNTIME_STOPPED',
			message: 'Runtime 已经停止。'
		}
	}
}

function recordRecovery(state, decision, failure, log) {
	const event = {
		strategy: decision.strategy,
		failureCode: failure.code,
		message: failure.message
	}

	state.recoveryEvents.push(event)
	state.trace.push({ type: 'recovery', ...event })
	log(`Recovery：${decision.strategy}`)
}

function applyHumanHandoff(state, failure) {
	state.status = 'waiting_for_human'
	state.planState.status = 'waiting_for_human'
	state.stopReason = {
		code: 'human_handoff',
		message: '自动恢复无法安全解决当前问题。'
	}
	state.handoff = {
		reasonCode: failure.code,
		summary: failure.message,
		requestedAction: '请人工核对证据冲突或补充缺失信息。',
		evidenceKeys: state.observations.map((item) => item.evidenceKey),
		planVersion: state.planState.version
	}
}

function completeRun(state) {
	state.status = 'completed'
	state.planState.status = 'completed'
	state.stopReason = {
		code: 'completed',
		message: '所有计划步骤均已获得通过校验的证据。'
	}
}

function createLogger(silent) {
	return silent ? () => {} : (...args) => console.log(...args)
}

function formatAction(action) {
	return `${action.toolName}(${JSON.stringify(action.arguments)})`
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function clone(value) {
	return JSON.parse(JSON.stringify(value))
}

module.exports = {
	runRecoveryAgent
}
