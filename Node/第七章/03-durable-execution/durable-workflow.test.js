import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import { createPresentationWorkflow } from './workflow.js'

test('失败后使用相同 thread_id 只继续未完成的节点', async () => {
	const checkpointer = new MemorySaver()
	const config = {
		configurable: {
			thread_id: 'durable-execution-test'
		}
	}
	let shouldFail = true
	const graph = createPresentationWorkflow({
		checkpointer,
		shouldFailSave: () => shouldFail
	})

	await assert.rejects(
		graph.invoke({ presentationId: 'PRESENTATION-TEST' }, config),
		/大纲存储服务暂时不可用/
	)

	const failedSnapshot = await graph.getState(config)
	assert.deepEqual(failedSnapshot.next, ['save_outline_draft'])
	assert.deepEqual(failedSnapshot.values.executionPath, [
		'prepare_requirements',
		'generate_outline'
	])

	shouldFail = false
	const result = await graph.invoke(null, config)

	assert.equal(result.draftSaved, true)
	assert.deepEqual(result.executionPath, [
		'prepare_requirements',
		'generate_outline',
		'save_outline_draft'
	])
})
