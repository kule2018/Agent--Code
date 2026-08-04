import { Inject, Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import type {
	AgentDecision,
	AgentRun,
	FinalReport,
	PlanStep,
	ProviderResult,
	RunMode,
	RunStatus,
	ToolAction,
	ToolObservation,
	TraceEvent
} from './agent.types'
import { AgentProviderService } from './agent-provider.service'
import { DecisionValidatorService } from './decision-validator.service'
import { ResultValidatorService } from './result-validator.service'
import { RunStoreService } from './run-store.service'
import { getScenario } from './scenarios'
import { ToolRegistryService } from './tool-registry.service'
import { WorkspaceService } from './workspace.service'

const DEFAULT_LIMITS = {
	maxIterations: 30,
	maxToolCalls: 25,
	maxFilesChanged: 8,
	maxDurationMs: 120_000,
	maxSameAction: 2
}

const ACTIVE_STATUSES: RunStatus[] = [
	'created',
	'planning',
	'running',
	'waiting_approval'
]

@Injectable()
export class AgentRuntimeService {
	private readonly activeExecutions = new Set<string>()

	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService,
		@Inject(RunStoreService)
		private readonly store: RunStoreService,
		@Inject(AgentProviderService)
		private readonly provider: AgentProviderService,
		@Inject(DecisionValidatorService)
		private readonly decisionValidator: DecisionValidatorService,
		@Inject(ToolRegistryService)
		private readonly tools: ToolRegistryService,
		@Inject(ResultValidatorService)
		private readonly validator: ResultValidatorService
	) {}

	listRuns(): AgentRun[] {
		return this.store.list()
	}

	getRun(id: string): AgentRun {
		return structuredClone(this.store.get(id))
	}

	async createRun(
		scenarioId: string,
		options: { requirement?: string; mode?: RunMode } = {}
	): Promise<AgentRun> {
		const scenario = getScenario(scenarioId)
		const mode = options.mode ?? 'replay'
		const requirement = (options.requirement ?? scenario.requirement).trim()
		if (!requirement) throw new Error('任务需求不能为空。')
		if (requirement.length > 1_000) throw new Error('任务需求不能超过 1000 个字符。')
		this.provider.assertAvailable(mode)
		const id = randomUUID()
		const now = new Date().toISOString()
		const run: AgentRun = {
			id,
			scenarioId,
			title: scenario.title,
			requirement,
			mode,
			model: null,
			status: 'planning',
			createdAt: now,
			updatedAt: now,
			startedAt: now,
			completionCriteria: scenario.completionCriteria,
			plan: {
				version: 1,
				goal: requirement,
				status: 'active',
				steps: scenario.initialSteps.map((step) => ({
					...structuredClone(step),
					status: 'pending',
					createdInVersion: 1
				}))
			},
			limits: { ...DEFAULT_LIMITS },
			usage: {
				iterations: 0,
				toolCalls: 0,
				commandRuns: 0,
				filesRead: 0,
				filesChanged: 0,
				approvalWaitMs: 0,
				recoveryCount: 0,
				modelCalls: 0,
				promptTokens: 0,
				completionTokens: 0,
				modelLatencyMs: 0
			},
			trace: [],
			observations: [],
			failures: [],
			pendingApproval: null,
			approvedActionIds: [],
			rejectedActionIds: [],
			actionFingerprints: {},
			playbookCursor: 0,
			verification: {
				testsPassed: null,
				typecheckPassed: null,
				lintPassed: null,
				buildPassed: null,
				changedPaths: [],
				deletedPaths: []
			},
			report: null,
			stopReason: null
		}

		await this.workspaces.create(id, scenario)
		this.addTrace(run, {
			type: 'plan',
			title: '创建任务计划',
			summary: `Plan v1 包含 ${run.plan.steps.length} 个步骤。`,
			status: 'info',
			data: { version: 1, steps: run.plan.steps, mode }
		})
		this.addTrace(run, {
			type: 'run',
			title: mode === 'ai' ? '使用 AI 模式执行' : '使用 Replay 模式执行',
			summary:
				mode === 'ai'
					? '每一轮 Action 由 DeepSeek 模型根据当前代码和 Observation 动态生成。'
					: '按照预设决策轨迹复现实验，不产生模型调用费用。',
			status: 'info',
			data: { requirement }
		})
		run.status = 'running'
		await this.store.save(run)
		this.schedule(id)
		return this.getRun(id)
	}

	async decideApproval(runId: string, approved: boolean): Promise<AgentRun> {
		const run = this.store.get(runId)
		const pending = run.pendingApproval

		if (!pending || run.status !== 'waiting_approval') {
			throw new Error('当前 Agent Run 没有等待处理的审批。')
		}

		if (!approved) {
			run.pendingApproval = null
			run.rejectedActionIds.push(pending.action.id)
			this.addTrace(run, {
				type: 'approval',
				title: '用户拒绝高风险操作',
				summary: `${pending.action.toolName} 未执行，任务已停止。`,
				status: 'warning',
				toolName: pending.action.toolName
			})
			this.finish(run, 'stopped', '用户拒绝了高风险操作。')
			await this.store.save(run)
			return this.getRun(runId)
		}

		// 用户思考和确认所花的时间不属于 Agent 的执行时间预算。
		run.usage.approvalWaitMs =
			(run.usage.approvalWaitMs ?? 0) +
			Math.max(0, Date.now() - Date.parse(pending.requestedAt))
		run.approvedActionIds.push(pending.action.id)
		run.status = 'running'
		this.addTrace(run, {
			type: 'approval',
			title: '用户批准高风险操作',
			summary: `${pending.action.toolName} 已获准执行。`,
			status: 'success',
			toolName: pending.action.toolName
		})
		await this.store.save(run)
		this.schedule(runId)
		return this.getRun(runId)
	}

	async cancelRun(runId: string): Promise<AgentRun> {
		const run = this.store.get(runId)

		if (!ACTIVE_STATUSES.includes(run.status)) {
			return this.getRun(runId)
		}

		run.pendingApproval = null
		this.finish(run, 'cancelled', '用户主动停止了本次 Agent Run。')
		await this.store.save(run)
		return this.getRun(runId)
	}

	private schedule(runId: string): void {
		setTimeout(() => void this.execute(runId), 80)
	}

	private async execute(runId: string): Promise<void> {
		if (this.activeExecutions.has(runId)) return
		this.activeExecutions.add(runId)

		try {
			const run = this.store.get(runId)

			while (run.status === 'running') {
				const budgetReason = this.checkBudgets(run)
				if (budgetReason) {
					this.finish(run, 'human_handoff', budgetReason)
					await this.store.save(run)
					break
				}

					run.usage.iterations += 1
					const approvedAction = this.getApprovedPendingAction(run)
					const providerResult: ProviderResult = approvedAction
						? {
							decision: { type: 'action', action: approvedAction },
							source: run.mode,
							model: run.model
						}
						: await this.provider.next(run)
					this.recordProviderResult(run, providerResult)
					this.decisionValidator.validate(run, providerResult.decision)
					const decision = providerResult.decision

					if (decision.type === 'replan') {
						this.applyReplan(run, decision)
						if (providerResult.source === 'replay') run.playbookCursor += 1
					await this.store.save(run)
					await pause()
					continue
				}

				if (decision.type === 'final') {
					await this.complete(run, decision.summary)
					await this.store.save(run)
					break
				}

					const action = decision.action
					const fingerprint = fingerprintAction(action)
					const repeated = approvedAction
						? run.actionFingerprints[fingerprint] ?? 1
						: (run.actionFingerprints[fingerprint] ?? 0) + 1
					if (!approvedAction) run.actionFingerprints[fingerprint] = repeated

					this.addTrace(run, {
						type: 'decision',
						title: approvedAction
							? '继续执行已经批准的 Action'
							: providerResult.source === 'ai'
								? '模型提出下一步 Action'
								: 'Replay 返回下一步 Action',
					summary: action.reasoning,
					status: 'info',
					stepId: action.stepId,
					toolName: action.toolName,
					data: { arguments: action.arguments }
				})

				if (repeated > run.limits.maxSameAction) {
					this.finish(run, 'human_handoff', '相同 Action 重复次数超过预算。')
					await this.store.save(run)
					break
				}

				if (
					this.tools.requiresApproval(action.toolName) &&
					!run.approvedActionIds.includes(action.id)
				) {
					run.pendingApproval = {
						action,
						risk: 'high',
						title: '需要人工批准高风险操作',
						description: `Agent 准备执行 ${action.toolName}：${action.reasoning}`,
						requestedAt: new Date().toISOString()
					}
					run.status = 'waiting_approval'
					this.addTrace(run, {
						type: 'approval',
						title: '执行已暂停，等待人工审批',
						summary: run.pendingApproval.description,
						status: 'warning',
						stepId: action.stepId,
						toolName: action.toolName,
						data: { arguments: action.arguments }
					})
					await this.store.save(run)
					break
				}

					await this.executeAction(run, action, providerResult.source)
				await this.store.save(run)
				await pause()
			}
		} catch (error) {
			const run = this.store.get(runId)
			this.finish(
				run,
				'failed',
				error instanceof Error ? error.message : 'Agent Runtime 执行失败。'
			)
			await this.store.save(run)
		} finally {
			this.activeExecutions.delete(runId)
		}
	}

	private async executeAction(
		run: AgentRun,
		action: ToolAction,
		source: RunMode
	): Promise<void> {
		run.usage.toolCalls += 1
		if (action.toolName.startsWith('run_')) run.usage.commandRuns += 1
		this.markStepRunning(run, action.stepId)
		this.addTrace(run, {
			type: 'action',
			title: `执行工具：${action.toolName}`,
			summary: formatArguments(action.arguments),
			status: 'info',
			stepId: action.stepId,
			toolName: action.toolName,
			data: { arguments: action.arguments }
		})

		try {
			const observation = await this.tools.execute(run, action)
			const validation = this.validator.validate(action, observation)
			this.addTrace(run, {
				type: 'observation',
				title: '工具返回 Observation',
				summary: observation.summary,
				status: observationStatus(observation),
				stepId: action.stepId,
				toolName: action.toolName,
				data: observation.data
			})
			this.addTrace(run, {
				type: 'validation',
				title: validation.valid ? 'Observation 校验通过' : 'Observation 校验失败',
				summary: validation.summary,
				status: validation.valid ? 'success' : 'error',
				stepId: action.stepId,
				toolName: action.toolName,
				data: { code: validation.code }
			})

			if (!validation.valid) {
				throw new Error(validation.summary)
			}

			run.observations.push(observation)
			this.updateVerification(run, action, observation)
			if (run.pendingApproval?.action.id === action.id) {
				run.pendingApproval = null
			}
			for (const stepId of action.completesStepIds ?? []) {
				this.completeStep(run, stepId)
			}
			if (source === 'replay') run.playbookCursor += 1
		} catch (error) {
			run.usage.recoveryCount += 1
			const message = error instanceof Error ? error.message : '工具执行失败。'
			const failure = {
				id: randomUUID(),
				actionId: action.id,
				toolName: action.toolName,
				stepId: action.stepId,
				message,
				createdAt: new Date().toISOString()
			}
			run.failures.push(failure)
			if (run.pendingApproval?.action.id === action.id) run.pendingApproval = null
			this.addTrace(run, {
				type: 'recovery',
				title:
					run.mode === 'ai' && run.usage.recoveryCount <= 2
						? '工具执行失败，交回模型重新决策'
						: '工具结果需要人工处理',
				summary: message,
				status: 'error',
				stepId: action.stepId,
				toolName: action.toolName
			})
			if (run.mode === 'ai' && run.usage.recoveryCount <= 2) {
				const step = run.plan.steps.find((item) => item.id === action.stepId)
				if (step?.status === 'running') step.status = 'pending'
				return
			}

			this.finish(run, 'human_handoff', message)
		}
	}

	private applyReplan(
		run: AgentRun,
		decision: Extract<AgentDecision, { type: 'replan' }>
	): void {
		run.plan.version += 1
		for (const id of decision.cancelStepIds ?? []) {
			const step = run.plan.steps.find((item) => item.id === id)
			if (step && step.status !== 'completed') step.status = 'cancelled'
		}

		const newSteps: PlanStep[] = decision.newSteps.map((step) => ({
			...structuredClone(step),
			status: 'pending',
			createdInVersion: run.plan.version
		}))
		run.plan.steps.push(...newSteps)
		this.addTrace(run, {
			type: 'plan',
			title: `更新任务计划：Plan v${run.plan.version}`,
			summary: decision.reason,
			status: 'warning',
			data: {
				addedSteps: newSteps,
				cancelledStepIds: decision.cancelStepIds ?? [],
				evidenceIds: decision.evidenceIds ?? []
			}
		})
	}

	private recordProviderResult(run: AgentRun, result: ProviderResult): void {
		if (result.source !== 'ai' || (result.latencyMs === undefined && !result.usage)) return
		run.model = result.model
		run.usage.modelCalls += 1
		run.usage.promptTokens += result.usage?.promptTokens ?? 0
		run.usage.completionTokens += result.usage?.completionTokens ?? 0
		run.usage.modelLatencyMs += result.latencyMs ?? 0
	}

	private async complete(run: AgentRun, summary: string): Promise<void> {
		const scenario = getScenario(run.scenarioId)
		const changes = await this.workspaces.getChanges(run.id)
		this.syncChanges(run, changes)
		const remainingIssues: string[] = []
		const unfinished = run.plan.steps.filter((step) => step.status === 'pending' || step.status === 'running')

		if (unfinished.length) {
			remainingIssues.push(`仍有 ${unfinished.length} 个计划步骤未完成。`)
		}
		for (const path of scenario.expected.changedPaths ?? []) {
			if (!changes.changedPaths.includes(path)) remainingIssues.push(`缺少预期修改：${path}`)
		}
		for (const path of scenario.expected.deletedPaths ?? []) {
			if (!changes.deletedPaths.includes(path)) remainingIssues.push(`目标文件尚未删除：${path}`)
		}
		if (scenario.expected.requireTests && run.verification.testsPassed !== true) {
			remainingIssues.push('测试尚未通过。')
		}
			if (scenario.expected.requireTypecheck && run.verification.typecheckPassed !== true) {
				remainingIssues.push('类型检查尚未通过。')
			}
			if (
				scenario.expected.requirePlanVersion &&
				run.plan.version < scenario.expected.requirePlanVersion
			) {
				remainingIssues.push(
					`当前任务需要根据失败证据更新到 Plan v${scenario.expected.requirePlanVersion}。`
				)
			}

		if (remainingIssues.length) {
			this.finish(run, 'human_handoff', remainingIssues.join(' '), summary, remainingIssues)
			return
		}

		run.plan.status = 'completed'
		this.finish(run, 'completed', '全部完成条件已经满足。', summary, [])
	}

	private checkBudgets(run: AgentRun): string | null {
		if (run.usage.iterations >= run.limits.maxIterations) return '达到最大迭代次数。'
		if (run.usage.toolCalls >= run.limits.maxToolCalls) return '达到最大工具调用次数。'
		if (run.usage.filesChanged > run.limits.maxFilesChanged) return '修改文件数量超过预算。'
		const executionDurationMs = run.startedAt
			? Date.now() - Date.parse(run.startedAt) - (run.usage.approvalWaitMs ?? 0)
			: 0
		if (executionDurationMs > run.limits.maxDurationMs) {
			return 'Agent Run 执行时间超过预算。'
		}
		return null
	}

	private updateVerification(
		run: AgentRun,
		action: ToolAction,
		observation: ToolObservation
	): void {
		const passed = observation.data.passed as boolean | undefined
		if (action.toolName === 'run_tests') run.verification.testsPassed = passed ?? null
		if (action.toolName === 'run_typecheck') run.verification.typecheckPassed = passed ?? null
		if (action.toolName === 'run_lint') run.verification.lintPassed = passed ?? null
		if (action.toolName === 'run_build') run.verification.buildPassed = passed ?? null
		if (action.toolName.startsWith('run_')) {
			run.verification.lastCommand = String(observation.data.command)
		}
		if (action.toolName === 'get_git_diff') {
			this.syncChanges(run, {
				changedPaths: observation.data.changedPaths as string[],
				deletedPaths: observation.data.deletedPaths as string[]
			})
		}
	}

	private syncChanges(
		run: AgentRun,
		changes: { changedPaths: string[]; deletedPaths: string[] }
	): void {
		run.verification.changedPaths = changes.changedPaths
		run.verification.deletedPaths = changes.deletedPaths
		run.usage.filesChanged = new Set([
			...changes.changedPaths,
			...changes.deletedPaths
		]).size
	}

	private markStepRunning(run: AgentRun, stepId?: string): void {
		const step = run.plan.steps.find((item) => item.id === stepId)
		if (step?.status === 'pending') step.status = 'running'
	}

	private completeStep(run: AgentRun, stepId: string): void {
		const step = run.plan.steps.find((item) => item.id === stepId)
		if (!step) return
		step.status = 'completed'
		step.completedAt = new Date().toISOString()
	}

	private getApprovedPendingAction(run: AgentRun): ToolAction | null {
		const pending = run.pendingApproval?.action
		if (!pending || !run.approvedActionIds.includes(pending.id)) return null
		return structuredClone(pending)
	}

	private finish(
		run: AgentRun,
		status: RunStatus,
		stopReason: string,
		summary = 'Agent Run 已停止。',
		remainingIssues: string[] = [stopReason]
	): void {
		run.status = status
		run.pendingApproval = null
		run.plan.status = status === 'completed' ? 'completed' : 'stopped'
		run.completedAt = new Date().toISOString()
		run.stopReason = stopReason
		const report: FinalReport = {
			status,
			summary,
			completedCriteria: run.completionCriteria.filter((_, index) =>
				this.criteriaSatisfied(run, index)
			),
			remainingIssues,
			changedPaths: run.verification.changedPaths,
			deletedPaths: run.verification.deletedPaths,
			verification: structuredClone(run.verification),
			stopReason
		}
		run.report = report
		this.addTrace(run, {
			type: 'report',
			title: status === 'completed' ? 'Agent Run 已完成' : 'Agent Run 已停止',
			summary: `${summary} ${stopReason}`,
			status: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning',
			data: { report }
		})
	}

	private criteriaSatisfied(run: AgentRun, index: number): boolean {
		if (index === run.completionCriteria.length - 1) {
			return run.verification.testsPassed === true && run.verification.typecheckPassed === true
		}
		return run.plan.steps.some((step) => step.status === 'completed')
	}

	private addTrace(run: AgentRun, event: Omit<TraceEvent, 'id' | 'createdAt'>): void {
		run.trace.push({
			...event,
			id: randomUUID(),
			createdAt: new Date().toISOString()
		})
	}
}

function fingerprintAction(action: ToolAction): string {
	return createHash('sha1')
		.update(`${action.toolName}:${JSON.stringify(action.arguments)}`)
		.digest('hex')
}

function formatArguments(args: Record<string, unknown>): string {
	const entries = Object.entries(args)
	if (!entries.length) return '本次调用不需要参数。'
	return entries
		.map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
		.join('，')
}

function observationStatus(observation: ToolObservation): TraceEvent['status'] {
	if (observation.toolName.startsWith('run_') && observation.data.passed === false) return 'warning'
	return observation.ok ? 'success' : 'error'
}

function pause(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 120))
}
