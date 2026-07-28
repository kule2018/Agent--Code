const API_URL =
	process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

/**
 * 调用 DeepSeek Chat Completions。
 *
 * 当前案例关闭思考模式，只观察模型提出的 Action、
 * 工具返回的 Observation 和最终回答。
 *
 * @param {object} input 模型调用参数
 * @param {Array} input.messages 当前完整消息
 * @param {Array} input.tools 当前可用工具
 * @returns {Promise<object>} 模型消息和调用统计
 */
async function callDeepSeek({ messages, tools }) {
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('缺少 DEEPSEEK_API_KEY，请先在 .env 中完成配置。')
	}

	const startedAt = Date.now()
	const response = await fetch(API_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			messages,
			tools,
			tool_choice: 'auto',
			thinking: {
				type: 'disabled'
			},
			temperature: 0.1
		})
	})

	const data = await response.json()

	if (!response.ok) {
		throw new Error(
			`DeepSeek 调用失败：${response.status} ${JSON.stringify(data)}`
		)
	}

	const choice = data.choices?.[0]

	if (!choice?.message) {
		throw new Error(`DeepSeek 没有返回有效消息：${JSON.stringify(data)}`)
	}

	return {
		message: choice.message,
		finishReason: choice.finish_reason,
		latencyMs: Date.now() - startedAt,
		usage: data.usage
	}
}

module.exports = {
	MODEL,
	callDeepSeek
}
