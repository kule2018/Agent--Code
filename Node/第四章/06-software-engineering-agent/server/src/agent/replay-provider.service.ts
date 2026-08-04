import { Injectable } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { AgentRun, ProviderResult } from './agent.types'
import { getScenario } from './scenarios'

/** 使用固定决策轨迹复现实验，不依赖模型 API。 */
@Injectable()
export class ReplayProviderService {
	async next(run: AgentRun): Promise<ProviderResult> {
		const scenario = getScenario(run.scenarioId)
		const template = scenario.playbook[run.playbookCursor]

		if (!template) {
			return {
				decision: { type: 'final', summary: '场景决策已经执行完毕。' },
				source: 'replay',
				model: null
			}
		}

		if (template.type === 'action') {
			return {
				decision: {
					type: 'action',
					action: {
						id: randomUUID(),
						toolName: template.toolName,
						arguments: structuredClone(template.arguments),
						stepId: template.stepId,
						reasoning: template.reasoning,
						completesStepIds: template.completesStepIds,
						recovery: template.recovery
					}
				},
				source: 'replay',
				model: null
			}
		}

		if (template.type === 'replan') {
			const latestFailure = [...run.observations]
				.reverse()
				.find((item) => item.data.passed === false)

			return {
				decision: {
					...structuredClone(template),
					evidenceIds:
						template.evidenceIds ??
						(latestFailure ? [latestFailure.id] : [])
				},
				source: 'replay',
				model: null
			}
		}

		return {
			decision: structuredClone(template),
			source: 'replay',
			model: null
		}
	}
}
