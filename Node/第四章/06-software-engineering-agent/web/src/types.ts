export type RunStatus =
	| 'created'
	| 'planning'
	| 'running'
	| 'waiting_approval'
	| 'completed'
	| 'completed_with_warnings'
	| 'human_handoff'
	| 'stopped'
	| 'failed'
	| 'cancelled'

export type RunMode = 'ai' | 'replay'

export interface Capabilities {
	ai: {
		available: boolean
		provider: string
		model: string
	}
	replay: { available: boolean }
}

export interface Scenario {
	id: string
	title: string
	shortDescription: string
	requirement: string
	category: 'feature' | 'bugfix' | 'refactor'
	completionCriteria: string[]
}

export interface PlanStep {
	id: string
	title: string
	description: string
	status: 'pending' | 'running' | 'completed' | 'cancelled'
	createdInVersion: number
}

export interface TraceEvent {
	id: string
	type: string
	title: string
	summary: string
	status: 'info' | 'success' | 'warning' | 'error'
	createdAt: string
	toolName?: string
	data?: Record<string, unknown>
}

export interface Verification {
	testsPassed: boolean | null
	typecheckPassed: boolean | null
	lintPassed: boolean | null
	buildPassed: boolean | null
	changedPaths: string[]
	deletedPaths: string[]
	lastCommand?: string
}

export interface AgentRun {
	id: string
	scenarioId: string
	title: string
	requirement: string
	mode: RunMode
	model: string | null
	status: RunStatus
	createdAt: string
	updatedAt: string
	completedAt?: string
	completionCriteria: string[]
	plan: {
		version: number
		goal: string
		status: string
		steps: PlanStep[]
	}
	limits: {
		maxIterations: number
		maxToolCalls: number
		maxFilesChanged: number
		maxDurationMs: number
		maxSameAction: number
	}
	usage: {
		iterations: number
		toolCalls: number
		commandRuns: number
		filesRead: number
		filesChanged: number
		approvalWaitMs: number
		recoveryCount: number
		modelCalls: number
		promptTokens: number
		completionTokens: number
		modelLatencyMs: number
	}
	trace: TraceEvent[]
	pendingApproval: null | {
		title: string
		description: string
		action: {
			toolName: string
			arguments: Record<string, unknown>
			reasoning: string
		}
	}
	verification: Verification
	report: null | {
		status: RunStatus
		summary: string
		completedCriteria: string[]
		remainingIssues: string[]
		changedPaths: string[]
		deletedPaths: string[]
		stopReason: string
	}
	stopReason: string | null
}
