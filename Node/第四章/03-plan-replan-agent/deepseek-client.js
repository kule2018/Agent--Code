const API_URL =
	process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/chat/completions'

const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

/**
 * 调用 DeepSeek Chat Completions。
 *
 * Planner 和 Replanner 使用 JSON Output，最终结论使用普通文本输出。
 *
 * @param {object} input 调用参数
 * @param {Array} input.messages 当前消息
 * @param {boolean} [input.jsonOutput=false] 是否要求返回 JSON
 * @param {number} [input.maxTokens=2400] 最大输出 Token
 * @returns {Promise<object>} 模型消息和调用统计
 */
async function callDeepSeek({
	messages,
	jsonOutput = false,
	maxTokens = 2400
}) {
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
			...(jsonOutput
				? {
						response_format: {
							type: 'json_object'
						}
					}
				: {}),
			thinking: {
				type: 'disabled'
			},
			temperature: 0.1,
			max_tokens: maxTokens
		})
	})

	const data = await response.json()

	if (!response.ok) {
		throw new Error(
			`DeepSeek 调用失败：${response.status} ${JSON.stringify(data)}`
		)
	}

	const message = data.choices?.[0]?.message

	if (!message) {
		throw new Error(`DeepSeek 没有返回有效消息：${JSON.stringify(data)}`)
	}

	return {
		message,
		latencyMs: Date.now() - startedAt,
		usage: data.usage
	}
}

module.exports = {
	MODEL,
	callDeepSeek
}

