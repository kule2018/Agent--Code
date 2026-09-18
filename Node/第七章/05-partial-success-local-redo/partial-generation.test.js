import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import { createPartialGenerationWorkflow } from './workflow.js'

function createTestRuntime(name) {
	const graph = createPartialGenerationWorkflow({
		checkpointer: new MemorySaver()
	})
	const config = {
		configurable: {
			thread_id: name
		}
	}

	return { graph, config }
}

async function start(graph, config) {
	await graph.invoke(
		{
			presentationId: 'PRESENTATION-TEST',
			operation: 'initial'
		},
		config
	)
	return graph.getState(config)
}

async function invokeExisting(graph, config, operation, extra = {}) {
	const snapshot = await graph.getState(config)
	return graph.invoke(
		{
			...snapshot.values,
			operation,
			targetPageId: null,
			changeRequest: null,
			...extra
		},
		config
	)
}

test('第一次运行保留成功页面，并把第三页标记为失败', async () => {
	const { graph, config } = createTestRuntime('partial-success')
	const snapshot = await start(graph, config)
	const page3 = snapshot.values.pageTasks.find(
		(task) => task.pageId === 'page-3'
	)

	assert.equal(snapshot.values.runStatus, 'partially_completed')
	assert.equal(snapshot.values.artifacts.length, 3)
	assert.equal(page3.status, 'failed')
})

test('继续执行时只补做失败页面', async () => {
	const { graph, config } = createTestRuntime('continue-failed')
	let snapshot = await start(graph, config)
	const page1Attempts = snapshot.values.pageTasks[0].attempts

	await invokeExisting(graph, config, 'continue')
	snapshot = await graph.getState(config)

	assert.equal(snapshot.values.runStatus, 'completed')
	assert.equal(snapshot.values.pageTasks[0].attempts, page1Attempts)
	assert.equal(snapshot.values.pageTasks[2].attempts, 2)
	assert.equal(snapshot.values.artifacts.length, 4)
})

test('修改单页时只生成该页的新修订', async () => {
	const { graph, config } = createTestRuntime('revise-page')
	await start(graph, config)
	await invokeExisting(graph, config, 'continue')
	let snapshot = await graph.getState(config)
	const originalArtifactId = snapshot.values.pageTasks[1].currentArtifactId

	await invokeExisting(graph, config, 'revise_page', {
		targetPageId: 'page-2',
		changeRequest: '调整第二页重点'
	})
	snapshot = await graph.getState(config)
	const revisedPage = snapshot.values.pageTasks[1]

	assert.equal(revisedPage.pageRevision, 2)
	assert.notEqual(revisedPage.currentArtifactId, originalArtifactId)
	assert.equal(snapshot.values.artifacts.length, 5)
	assert.equal(snapshot.values.pageTasks[0].attempts, 1)
})

test('新版大纲发布后拒绝混用旧页面，补做完成后才能导出', async () => {
	const { graph, config } = createTestRuntime('version-check')
	await start(graph, config)
	await invokeExisting(graph, config, 'continue')
	await invokeExisting(graph, config, 'publish_outline')
	await invokeExisting(graph, config, 'export')

	let snapshot = await graph.getState(config)
	assert.equal(snapshot.values.exportResult.ok, false)
	assert.equal(snapshot.values.runStatus, 'export_blocked')

	await invokeExisting(graph, config, 'continue')
	await invokeExisting(graph, config, 'export')
	snapshot = await graph.getState(config)

	assert.equal(snapshot.values.exportResult.ok, true)
	assert.equal(snapshot.values.runStatus, 'exported')
	assert.equal(snapshot.values.exportResult.artifactIds.length, 4)
})
