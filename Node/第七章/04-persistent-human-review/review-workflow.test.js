import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySaver } from '@langchain/langgraph'
import {
	Command,
	createReviewWorkflow,
	getPendingReview,
	validateReviewSubmission
} from './workflow.js'

function createTestRuntime(name) {
	const checkpointer = new MemorySaver()
	const graph = createReviewWorkflow({ checkpointer })
	const config = {
		configurable: {
			thread_id: name
		}
	}

	return { graph, config }
}

async function startReview(graph, config) {
	await graph.invoke({ presentationId: 'PRESENTATION-TEST' }, config)
	return graph.getState(config)
}

test('批准当前大纲后开始页面制作', async () => {
	const { graph, config } = createTestRuntime('approve-test')
	const snapshot = await startReview(graph, config)
	const pendingReview = getPendingReview(snapshot)

	assert.equal(pendingReview.outlineVersion, 1)

	const decision = validateReviewSubmission(snapshot, {
		presentationId: 'PRESENTATION-TEST',
		outlineVersion: 1,
		action: 'approve',
		feedback: null
	})

	const result = await graph.invoke(new Command({ resume: decision }), config)

	assert.equal(result.reviewStatus, 'approved')
	assert.equal(result.pageProductionStarted, true)
})

test('提出修改后生成新版大纲并再次暂停', async () => {
	const { graph, config } = createTestRuntime('revise-test')
	const firstSnapshot = await startReview(graph, config)
	const decision = validateReviewSubmission(firstSnapshot, {
		presentationId: 'PRESENTATION-TEST',
		outlineVersion: 1,
		action: 'revise',
		feedback: '补充风险控制方案'
	})

	await graph.invoke(new Command({ resume: decision }), config)
	const secondSnapshot = await graph.getState(config)
	const pendingReview = getPendingReview(secondSnapshot)

	assert.equal(secondSnapshot.values.outline.version, 2)
	assert.equal(secondSnapshot.values.reviewStatus, 'pending')
	assert.equal(pendingReview.outlineVersion, 2)
	assert.deepEqual(secondSnapshot.next, ['review_outline'])
})

test('拒绝大纲后结束任务', async () => {
	const { graph, config } = createTestRuntime('reject-test')
	const snapshot = await startReview(graph, config)
	const decision = validateReviewSubmission(snapshot, {
		presentationId: 'PRESENTATION-TEST',
		outlineVersion: 1,
		action: 'reject',
		feedback: null
	})

	const result = await graph.invoke(new Command({ resume: decision }), config)

	assert.equal(result.reviewStatus, 'rejected')
	assert.equal(result.pageProductionStarted, false)
})

test('旧版本审核不能恢复当前工作流', async () => {
	const { graph, config } = createTestRuntime('stale-test')
	const snapshot = await startReview(graph, config)

	assert.throws(
		() =>
			validateReviewSubmission(snapshot, {
				presentationId: 'PRESENTATION-TEST',
				outlineVersion: 0,
				action: 'approve',
				feedback: null
			}),
		/审核版本已经过期/
	)
})
