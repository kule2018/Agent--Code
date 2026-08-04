import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Inject,
	Param,
	Post
} from '@nestjs/common'
import { AgentRuntimeService } from './agent-runtime.service'
import { AgentProviderService } from './agent-provider.service'
import type { RunMode } from './agent.types'
import { SCENARIOS } from './scenarios'
import { ToolRegistryService } from './tool-registry.service'

@Controller()
export class RunsController {
	constructor(
		@Inject(AgentRuntimeService)
		private readonly runtime: AgentRuntimeService,
		@Inject(AgentProviderService)
		private readonly providers: AgentProviderService,
		@Inject(ToolRegistryService)
		private readonly tools: ToolRegistryService
	) {}

	@Get('health')
	health() {
		return { ok: true, service: 'software-engineering-agent' }
	}

	@Get('scenarios')
	listScenarios() {
		return SCENARIOS.map((scenario) => ({
			id: scenario.id,
			title: scenario.title,
			shortDescription: scenario.shortDescription,
			requirement: scenario.requirement,
			category: scenario.category,
			completionCriteria: scenario.completionCriteria
		}))
	}

	@Get('tools')
	listTools() {
		return this.tools.list()
	}

	@Get('capabilities')
	capabilities() {
		return this.providers.capabilities()
	}

	@Get('runs')
	listRuns() {
		return this.runtime.listRuns()
	}

	@Post('runs')
	async createRun(
		@Body()
		body: { scenarioId?: string; requirement?: string; mode?: RunMode }
	) {
		if (!body.scenarioId) {
			throw new BadRequestException('scenarioId 不能为空。')
		}

		try {
			if (body.mode && body.mode !== 'ai' && body.mode !== 'replay') {
				throw new Error('mode 只能是 ai 或 replay。')
			}
			return await this.runtime.createRun(body.scenarioId, {
				requirement: body.requirement,
				mode: body.mode
			})
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}

	@Get('runs/:id')
	getRun(@Param('id') id: string) {
		try {
			return this.runtime.getRun(id)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}

	@Post('runs/:id/approval')
	async approve(
		@Param('id') id: string,
		@Body() body: { approved?: boolean }
	) {
		if (typeof body.approved !== 'boolean') {
			throw new BadRequestException('approved 必须是布尔值。')
		}

		try {
			return await this.runtime.decideApproval(id, body.approved)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}

	@Post('runs/:id/cancel')
	async cancel(@Param('id') id: string) {
		try {
			return await this.runtime.cancelRun(id)
		} catch (error) {
			throw new BadRequestException(toMessage(error))
		}
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : '请求处理失败。'
}
