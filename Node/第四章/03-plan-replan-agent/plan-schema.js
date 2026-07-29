const { z } = require('zod')

const planStepSchema = z.object({
	id: z.string().regex(/^step-\d+$/),
	title: z.string().min(1),
	toolName: z.string().min(1),
	arguments: z.object({
		serviceName: z.string().min(1)
	}),
	dependsOn: z.array(z.string()).default([])
})

const initialPlanSchema = z.object({
	planSummary: z.string().min(1),
	steps: z.array(planStepSchema).length(2)
})

const replanDecisionSchema = z.object({
	decision: z.enum(['continue', 'finish']),
	reason: z.string().min(1),
	planSummary: z.string().min(1),
	cancelStepIds: z.array(z.string()).default([]),
	newSteps: z.array(planStepSchema).max(1).default([])
})

/**
 * 解析并校验模型返回的 JSON。
 *
 * JSON Output 只能保证返回内容是合法 JSON，
 * 具体字段和业务约束仍然需要应用程序自己校验。
 *
 * @param {string} content 模型返回内容
 * @param {z.ZodType} schema 对应的 Zod Schema
 * @param {string} stage 当前调用阶段
 * @returns {object} 通过校验的结构化结果
 */
function parseModelJson(content, schema, stage) {
	if (!content) {
		throw new Error(`${stage} 没有返回内容。`)
	}

	let json

	try {
		json = JSON.parse(content)
	} catch {
		throw new Error(`${stage} 返回的内容不是合法 JSON：${content}`)
	}

	const result = schema.safeParse(json)

	if (!result.success) {
		throw new Error(
			`${stage} 返回结构不符合要求：${JSON.stringify(result.error.issues)}`
		)
	}

	return result.data
}

module.exports = {
	initialPlanSchema,
	replanDecisionSchema,
	parseModelJson
}
