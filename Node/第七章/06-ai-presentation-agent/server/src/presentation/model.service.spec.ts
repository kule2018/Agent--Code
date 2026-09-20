import { describe, expect, it } from 'vitest'
import { PresentationAggregate } from './presentation.aggregate.js'
import { PresentationModelService } from './model.service.js'

const input = {
	modelMode: 'replay' as const,
	topic: '企业 Agent 发布方案',
	audience: '技术负责人',
	pageCount: 5,
	additionalRequirements: '',
	sourceText: '这是一份长度足够的企业 Agent 课程资料，用于测试大纲修改流程。',
	sourceName: 'source.md'
}

describe('PresentationModelService', () => {
	it('可以把“增加一页”转换成新的页数要求', async () => {
		const presentation = PresentationAggregate.create(input).toJSON()
		const provider = new PresentationModelService().getProvider('replay')

		const plan = await provider.planChange({
			instruction: '增加一页企业 Agent 落地风险与控制方案。',
			presentation
		})

		expect(plan.scope).toBe('global_content')
		expect(plan.nextRequirements?.pageCount).toBe(6)

		const draft = await provider.generateOutline({
			requirements: {
				...presentation.requirements,
				...plan.nextRequirements
			},
			version: 2,
			previousOutline: null,
			feedback: '增加一页企业 Agent 落地风险与控制方案。'
		})

		expect(draft.slides).toHaveLength(6)
	})
})
