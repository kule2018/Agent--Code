import { Inject, Injectable } from '@nestjs/common'
import type {
	ChatCompletionMessageParam,
	ChatCompletionTool
} from 'openai/resources/chat/completions'
import { executeOrderTool } from '../../03-automatic-scoring/src/agent.service.js'
import { ModelService } from '../../03-automatic-scoring/src/model.service.js'
import type {
	AgentResult,
	Order,
	Sample,
	ToolRecord
} from '../../03-automatic-scoring/src/sample.js'
import { TraceService } from './trace.service.js'

export type Variant = 'wrong-unit' | 'fixed' | 'repeat'
const tools: ChatCompletionTool[] = [
	{
		type: 'function',
		function: {
			name: 'get_order',
			description:
				'根据订单号查询当前登录用户的订单，paidAmountYuan 的单位为元。',
			parameters: {
				type: 'object',
				properties: { orderId: { type: 'string' } },
				required: ['orderId'],
				additionalProperties: false
			}
		}
	}
]
const SYSTEM_PROMPT =
	'你是售后查询助手。必须通过 get_order 查询订单后回答，金额字段 paidAmountYuan 的单位为元。' +
	'资料不足时说明缺少什么，不猜测，不承诺退款批准或到账。'

/** 错误代码：把已经以元保存的金额，误当成分又除以 100；不修改原始订单。 */
export function buildToolMessage(
	result: ToolRecord['result'],
	variant: Variant
) {
	const payload = structuredClone(result)
	if (variant === 'wrong-unit' && payload.order) {
		payload.order.paidAmountYuan /= 100
	}
	return JSON.stringify(payload)
}

@Injectable()
export class TracedAgentService {
	constructor(
		// 注入模型服务，用于调用大模型完成推理和 Tool Calling。
		@Inject(ModelService) private readonly model: ModelService,

		// 注入 Trace 服务，用于记录模型调用、工具调用以及中间数据转换过程。
		@Inject(TraceService) private readonly trace: TraceService
	) {}

	async run(
		// 用户输入信息，包括问题和上下文信息。
		inputs: Sample['inputs'],

		// 模拟订单数据，供 get_order Tool 查询。
		orders: Order[],

		// 实验模式：
		// wrong-unit：模拟应用处理工具结果时出现错误。
		// fixed：正常流程。
		// repeat：模拟应用重复执行 Tool。
		variant: Variant
	): Promise<AgentResult> {
		// 保存 Agent 执行过程中产生的所有 Tool 调用记录。
		const toolCalls: ToolRecord[] = []

		// 初始化模型上下文消息。
		// 第一条 system 消息告诉模型角色和可使用的工具。
		// 第二条 user 消息保存用户真实问题。
		const messages: ChatCompletionMessageParam[] = [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: inputs.turns[0] }
		]

		try {
			// 限制最多执行 4 轮模型调用。
			// 防止模型不断调用工具导致无限循环。
			for (let round = 0; round < 4; round++) {
				// 调用模型。
				// 模型会根据当前 messages 判断：
				// 1. 是否直接回答用户；
				// 2. 是否需要调用 Tool。
				const message = await this.model.complete('agent', {
					messages,
					tools
				})

				// 如果模型没有返回 Tool Call，
				// 说明模型已经认为信息足够，可以直接生成最终答案。
				if (!message.tool_calls?.length) {
					return {
						origin: 'live',
						status: 'completed',
						answer: message.content || '',
						toolCalls
					}
				}

				// 保存模型产生的 assistant 消息。
				// 后续需要把 Tool 执行结果继续传回模型，
				// 所以必须保留这次 Tool Call 信息。
				messages.push({
					role: 'assistant',
					content: message.content,
					tool_calls: message.tool_calls
				})

				// 一个 assistant 消息可能包含多个 Tool Call。
				// 这里逐个执行模型要求调用的工具。
				for (const call of message.tool_calls) {
					// 本示例只支持 OpenAI Function Calling 类型的 Tool。
					if (call.type !== 'function')
						throw new Error('本例只支持 Function Tool。')

					// 解析模型生成的参数。
					// 正常情况下 arguments 是 JSON 字符串。
					// 如果 JSON 解析失败，则保留原始字符串方便 Trace 排查。
					let args: unknown
					try {
						args = JSON.parse(call.function.arguments)
					} catch {
						args = call.function.arguments
					}

					// 封装一次 Tool 执行过程。
					// 后续 repeat 实验会复用这个函数，
					// 模拟应用层重复执行 Tool 的问题。
					const execute = async () => {
						// 限制 Tool 调用总次数。
						// 避免异常情况下无限调用。
						if (toolCalls.length >= 6)
							throw new Error('工具调用次数达到本例上限。')

						// 使用 Trace 记录 Tool 执行过程。
						//
						// Trace 中保存：
						// - Tool 名称
						// - Tool 参数
						// - 用户上下文
						// - Tool 返回结果
						const record = await this.trace.capture(
							'get_order',
							'tool',
							{
								toolCallId: call.id,
								name: call.function.name,
								args,
								context: inputs.context
							},
							() =>
								executeOrderTool(
									call.function.name,
									args,
									inputs.context,
									orders
								)
						)

						// 保存 Tool 调用记录。
						toolCalls.push(record)

						return record
					}

					// 执行模型请求的 Tool。
					let record = await execute()

					// repeat 实验：
					// 模型只请求了一次查询，
					// 但是应用代码主动重复执行了一次 Tool。
					//
					// 用于演示：
					// 如果只保存模型请求和最终回答，
					// 可能无法发现应用内部重复执行的问题。
					if (variant === 'repeat' && record.result.found)
						record = await execute()

					// 将 Tool 结果转换成模型可以理解的消息格式。
					//
					// 这里单独记录 transform Trace，
					// 因为真实系统中经常会发生：
					// Tool 返回正确数据，
					// 但应用组装消息时修改错误。
					const content = await this.trace.capture(
						'build_tool_message',
						'transform',
						{
							toolCallId: call.id,
							result: record.result
						},
						() => buildToolMessage(record.result, variant)
					)

					// 把 Tool 返回内容放回消息列表。
					// 下一轮模型调用时，模型会看到：
					//
					// assistant:
					//   我要调用 get_order
					//
					// tool:
					//   查询结果……
					messages.push({
						role: 'tool',
						tool_call_id: call.id,
						content
					})
				}
			}

			// 如果超过最大循环次数仍未结束，
			// 说明 Agent 没有正常完成任务。
			throw new Error('模型调用轮次达到本例上限。')
		} catch (error) {
			// 捕获整个 Agent 执行过程中的异常。
			// 返回错误状态，同时保留已经产生的 Tool 调用记录，
			// 方便通过 Trace 分析失败原因。
			return {
				origin: 'live',
				status: 'error',
				answer: '',
				toolCalls,
				error: error instanceof Error ? error.message : String(error)
			}
		}
	}
}
