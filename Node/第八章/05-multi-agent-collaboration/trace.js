import { createMiddleware } from 'langchain'

/** 提取 Message 中的文本，兼容字符串和文本内容块。 */
export function messageText(message) {
	if (typeof message?.content === 'string') return message.content
	return (message?.content ?? [])
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
}

/** 普通工具直接返回 ToolMessage，task 则通过 Command 携带 ToolMessage。 */
export function toolResult(result, callId) {
	const messages = result?.update?.messages
	if (Array.isArray(messages)) {
		return messages.find((message) => message.tool_call_id === callId)
	}
	return result?.tool_call_id === callId ? result : undefined
}

/** 记录各 Agent 的输入与实际工具调用，仅用于观察，不改变委派逻辑。 */
export function createTraceMiddleware(actor, trace) {
	return createMiddleware({
		name: `Trace_${actor}`,
		beforeModel(state) {
			if (!trace.inputs.has(actor)) {
				const messages = state.messages.map((message) => ({
					type: message.type,
					content: messageText(message)
				}))
				trace.inputs.set(actor, messages)
				console.log(`\n[${actor}] 首次模型调用，messages 数量：${messages.length}`)
				if (actor === 'plot-designer') {
					console.log('剧情设计师收到的任务：\n', messages.at(-1)?.content)
				}
			}
		},
		async wrapToolCall(request, handler) {
			const { id, name, args } = request.toolCall
			const call = { actor, id, name, args, ok: false, text: '' }
			trace.calls.push(call)
			console.log(`\n[${actor}] 调用 ${name}${args.file_path ? ` ${args.file_path}` : ''}`)
			if (name === 'task') {
				console.log('委派参数：\n', JSON.stringify(args, null, 2))
			}
			try {
				const result = await handler(request)
				const message = toolResult(result, id)
				call.text = messageText(message)
				call.ok = Boolean(message) && message.status !== 'error' && !/^Error:/i.test(call.text)
				console.log(`[${actor}] ${name}：${call.ok ? '成功' : '失败'}`)
				if (name === 'task' || !call.ok) console.log(call.text)
				return result
			} catch (error) {
				call.text = error.message
				console.error(`[${actor}] ${name}：${error.message}`)
				throw error
			}
		}
	})
}

/** 按消息类型展示主 Agent 的历史，不把子 Agent 的内部调用混入其中。 */
export function printMainMessages(messages) {
	console.log('\n总导演最终的 messages：')
	for (const message of messages) {
		if (message.tool_calls?.length) {
			console.log(`AIMessage：调用 ${message.tool_calls.map((call) => call.name).join(', ')}`)
		} else if (message.tool_call_id) {
			console.log(`ToolMessage：${message.name} 返回结果`)
		} else {
			console.log(message.type === 'human' ? 'HumanMessage：用户任务' : 'AIMessage：回复正文')
		}
	}
}
