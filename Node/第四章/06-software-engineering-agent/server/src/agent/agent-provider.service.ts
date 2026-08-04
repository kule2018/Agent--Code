import { Inject, Injectable } from '@nestjs/common'
import type { AgentRun, ProviderResult, RunMode } from './agent.types'
import { DeepSeekProviderService } from './deepseek-provider.service'
import { ReplayProviderService } from './replay-provider.service'

@Injectable()
export class AgentProviderService {
	constructor(
		@Inject(ReplayProviderService)
		private readonly replay: ReplayProviderService,
		@Inject(DeepSeekProviderService)
		private readonly deepseek: DeepSeekProviderService
	) {}

	next(run: AgentRun): Promise<ProviderResult> {
		return run.mode === 'ai' ? this.deepseek.next(run) : this.replay.next(run)
	}

	assertAvailable(mode: RunMode): void {
		if (mode === 'ai' && !this.deepseek.isAvailable()) {
			throw new Error('AI 模式需要 DEEPSEEK_API_KEY；未配置时请使用 Replay 模式。')
		}
	}

	capabilities() {
		return {
			ai: {
				available: this.deepseek.isAvailable(),
				provider: 'DeepSeek 开放平台',
				model: this.deepseek.model()
			},
			replay: { available: true }
		}
	}
}
