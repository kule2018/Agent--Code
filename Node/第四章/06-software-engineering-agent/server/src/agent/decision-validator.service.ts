import { Injectable } from '@nestjs/common'
import type { AgentDecision, AgentRun, ToolAction, ToolName } from './agent.types'
import { getScenario } from './scenarios'

const TOOL_NAMES: ToolName[] = [
	'list_files',
	'search_code',
	'read_file',
	'apply_patch',
	'delete_file',
	'run_tests',
	'run_typecheck',
	'run_lint',
	'run_build',
	'get_git_diff'
]

/** 在模型决策进入 Runtime 前检查工具、参数、步骤和场景边界。 */
@Injectable()
export class DecisionValidatorService {
	validate(run: AgentRun, decision: AgentDecision): void {
		if (decision.type === 'action') {
			this.validateAction(run, decision.action)
			return
		}

		if (decision.type === 'replan') {
			this.validateReplan(run, decision)
			return
		}

		if (!decision.summary.trim()) throw new Error('Final summary 不能为空。')
	}

	private validateAction(run: AgentRun, action: ToolAction): void {
		if (!TOOL_NAMES.includes(action.toolName)) {
			throw new Error(`模型提出了未开放的工具：${String(action.toolName)}`)
		}
		if (!action.reasoning.trim()) throw new Error('Action reasoning 不能为空。')

		if (action.stepId && !run.plan.steps.some((step) => step.id === action.stepId)) {
			throw new Error(`Action 引用了不存在的步骤：${action.stepId}`)
		}
		for (const stepId of action.completesStepIds ?? []) {
			if (!run.plan.steps.some((step) => step.id === stepId)) {
				throw new Error(`Action 准备完成不存在的步骤：${stepId}`)
			}
		}

		const scenario = getScenario(run.scenarioId)
		const args = action.arguments
		if (action.toolName === 'search_code') requireString(args.query, 'query')
		if (action.toolName === 'read_file') requireString(args.path, 'path')

		if (action.toolName === 'apply_patch') {
			const path = requireString(args.path, 'path')
			if (!scenario.workspacePolicy.writablePaths.includes(path)) {
				throw new Error(`当前场景不允许修改文件：${path}`)
			}
			const replacements = args.replacements
			if (!Array.isArray(replacements) || replacements.length === 0 || replacements.length > 6) {
				throw new Error('apply_patch 的 replacements 数量必须在 1 到 6 之间。')
			}
			for (const item of replacements) {
				const replacement = item as Record<string, unknown>
				requireString(replacement.search, 'replacement.search')
				if (typeof replacement.replacement !== 'string') {
					throw new Error('replacement.replacement 必须是字符串。')
				}
			}
		}

		if (action.toolName === 'delete_file') {
			const path = requireString(args.path, 'path')
			if (!scenario.workspacePolicy.deletablePaths.includes(path)) {
				throw new Error(`当前场景不允许删除文件：${path}`)
			}
		}

		if (action.toolName.startsWith('run_') || action.toolName === 'get_git_diff' || action.toolName === 'list_files') {
			if (Object.keys(args).length > 0) {
				throw new Error(`${action.toolName} 不接收参数。`)
			}
		}
	}

	private validateReplan(
		run: AgentRun,
		decision: Extract<AgentDecision, { type: 'replan' }>
	): void {
		if (!decision.reason.trim()) throw new Error('Replan reason 不能为空。')
		if (!decision.newSteps.length || decision.newSteps.length > 3) {
			throw new Error('一次 Replan 必须新增 1 到 3 个步骤。')
		}

		const evidenceIds = decision.evidenceIds ?? []
		if (!evidenceIds.length) throw new Error('Replan 必须引用触发调整的证据。')
		for (const id of evidenceIds) {
			const observation = run.observations.find((item) => item.id === id)
			const failure = run.failures.find((item) => item.id === id)
			if (!observation && !failure) throw new Error(`Replan 引用了不存在的证据：${id}`)
		}

		const existingIds = new Set(run.plan.steps.map((step) => step.id))
		const newIds = new Set<string>()
		for (const step of decision.newSteps) {
			if (!step.id?.trim() || !step.title?.trim() || !step.description?.trim()) {
				throw new Error('Replan 新步骤缺少 id、title 或 description。')
			}
			if (existingIds.has(step.id) || newIds.has(step.id)) {
				throw new Error(`Replan 步骤 ID 重复：${step.id}`)
			}
			newIds.add(step.id)
		}
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`${field} 必须是非空字符串。`)
	}
	return value
}
