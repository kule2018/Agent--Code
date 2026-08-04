import { Inject, Injectable } from '@nestjs/common'
import type { AgentRun } from './agent.types'
import { WorkspaceService } from './workspace.service'

@Injectable()
export class RunStoreService {
	private readonly runs = new Map<string, AgentRun>()

	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService
	) {}

	list(): AgentRun[] {
		return [...this.runs.values()]
			.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
			.map((run) => structuredClone(run))
	}

	get(id: string): AgentRun {
		const run = this.runs.get(id)

		if (!run) {
			throw new Error(`Agent Run 不存在：${id}`)
		}

		return run
	}

	async save(run: AgentRun): Promise<void> {
		run.updatedAt = new Date().toISOString()
		this.runs.set(run.id, run)
		await this.workspaces.persistRun(run.id, run)
	}
}
