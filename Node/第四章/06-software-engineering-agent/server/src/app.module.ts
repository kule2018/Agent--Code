import { Module } from '@nestjs/common'
import { AgentRuntimeService } from './agent/agent-runtime.service'
import { AgentContextService } from './agent/agent-context.service'
import { AgentProviderService } from './agent/agent-provider.service'
import { CommandService } from './agent/command.service'
import { DecisionValidatorService } from './agent/decision-validator.service'
import { DeepSeekProviderService } from './agent/deepseek-provider.service'
import { ReplayProviderService } from './agent/replay-provider.service'
import { ResultValidatorService } from './agent/result-validator.service'
import { RunStoreService } from './agent/run-store.service'
import { RunsController } from './agent/runs.controller'
import { ToolRegistryService } from './agent/tool-registry.service'
import { WorkspaceService } from './agent/workspace.service'

@Module({
	controllers: [RunsController],
	providers: [
		AgentContextService,
		AgentProviderService,
		AgentRuntimeService,
		CommandService,
		DeepSeekProviderService,
		DecisionValidatorService,
		ReplayProviderService,
		ResultValidatorService,
		RunStoreService,
		ToolRegistryService,
		WorkspaceService
	]
})
export class AppModule {}
