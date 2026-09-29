import assert from 'node:assert/strict'
import test from 'node:test'
import { messageText, toolResult } from './trace.js'

test('读取字符串或内容块中的文本', () => {
	assert.equal(messageText({ content: '完成' }), '完成')
	assert.equal(messageText({ content: [{ type: 'text', text: '报告' }, { type: 'image' }] }), '报告')
	assert.equal(messageText(undefined), '')
})

test('普通工具结果按 Tool Call ID 匹配', () => {
	const message = { tool_call_id: 'read-1', content: '世界观' }
	assert.equal(toolResult(message, 'read-1'), message)
	assert.equal(toolResult(message, 'wrong-id'), undefined)
})

test('task 的 Command 里按 ID 提取对应 ToolMessage', () => {
	const message = { tool_call_id: 'task-1', content: '大纲已交付' }
	const command = { update: { messages: [message, { tool_call_id: 'other' }] } }
	assert.equal(toolResult(command, 'task-1'), message)
	assert.equal(toolResult(command, 'wrong-id'), undefined)
})
