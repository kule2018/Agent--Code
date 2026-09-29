import assert from 'node:assert/strict'
import test from 'node:test'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadScenes, validateScenes, validateReview, checkRepairScope } from './contracts.js'
import { runReviewLoop } from './workflow.js'

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))
const original = await loadScenes(fixtures)
const issue = {
	filePath: '/game/scenes/ending-b.json',
	rule: '世界规则 1：无法恢复对外通信，也无法获得外部救援。',
	quote: '林澜恢复了对外通信，成功联系地球，救援飞船赶到并接走了所有人。',
	reason: '外部救援与世界规则冲突。',
	suggestion: '改为利用休眠降低消耗，保留暂停维修的代价。'
}
const failedReview = { verdict: 'needs_revision', issues: [issue] }
const passedReview = { verdict: 'approved', issues: [] }

/** 为工作流测试建立隔离副本，测试结束后清理，不使用真实模型。 */
async function workspace(t) {
	const path = await mkdtemp(join(tmpdir(), 'agent-review-test-'))
	await cp(fixtures, path, { recursive: true })
	await mkdir(join(path, 'reviews'))
	t.after(() => rm(path, { recursive: true, force: true }))
	return path
}

test('缺陷样本可以通过结构检查，语义判断需要另一条检查链', () => {
	assert.deepEqual(validateScenes(original), [])
})

test('拒绝不符合场景 Schema 的字段', () => {
	const entries = structuredClone(original)
	entries[0].data.ending = 'false'
	assert.equal(validateScenes(entries)[0].rule, 'schema')
})

test('检查不存在的选择目标和重复 ID', () => {
	const entries = structuredClone(original)
	entries[0].data.choices[0].nextSceneId = 'missing'
	assert.ok(validateScenes(entries).some((item) => item.rule === 'missing_target'))
	entries[2].data.id = 'ending-a'
	assert.ok(validateScenes(entries).some((item) => item.rule === 'duplicate_id'))
})

test('检查不可达场景和本例禁止的循环分支', () => {
	const entries = structuredClone(original)
	entries[0].data.choices[1].nextSceneId = 'ending-a'
	assert.ok(validateScenes(entries).some((item) => item.rule === 'unreachable'))
	entries[0].data.choices[1].nextSceneId = 'scene-01'
	assert.ok(validateScenes(entries).some((item) => item.rule === 'cycle'))
})

test('检查结局数量、非结局死路与结局后续选项', () => {
	const entries = structuredClone(original)
	entries[0].data.choices = []
	assert.ok(validateScenes(entries).some((item) => item.rule === 'dead_end'))
	entries[0].data.ending = true
	assert.ok(validateScenes(entries).some((item) => item.rule === 'ending_count'))
	entries[0].data.choices = original[0].data.choices
	assert.ok(validateScenes(entries).some((item) => item.rule === 'ending_choices'))
})

test('审核报告必须引用真实正文，结论与问题列表一致', () => {
	assert.deepEqual(validateReview(failedReview, original), failedReview)
	assert.throws(() => validateReview({ ...failedReview, verdict: 'approved' }, original), /不一致/)
	assert.throws(() => validateReview({ ...failedReview, issues: [{ ...issue, quote: '虚构引用' }] }, original), /不存在/)
	assert.throws(() => validateReview({ ...failedReview, issues: [{ ...issue, filePath: '/outside.json' }] }, original))
})

test('局部返工不能改其他文件、分支结构或完全不修改', () => {
	const after = structuredClone(original)
	after[1].raw += '\n'
	assert.throws(() => checkRepairScope(original, after, [issue.filePath]), /未授权/)
	after[1] = original[1]
	after[2].data.ending = false
	after[2].raw = JSON.stringify(after[2].data)
	assert.throws(() => checkRepairScope(original, after, [issue.filePath]), /分支结构/)
	assert.throws(() => checkRepairScope(original, original, [issue.filePath]), /没有产生/)
})

test('修复后重新检查，通过才写入 ready，其他文件字节不变', async (t) => {
	const workspaceDir = await workspace(t)
	let reviews = 0
	const result = await runReviewLoop({
		workspaceDir,
		log() {},
		async delegate(task) {
			if (task.assignee === 'continuity-reviewer') {
				await writeFile(join(workspaceDir, task.writeFiles[0]), JSON.stringify(reviews++ === 0 ? failedReview : passedReview))
			} else {
				assert.deepEqual(task.writeFiles, [issue.filePath])
				const data = { ...original[2].data, content: '大家进入休眠舱降低消耗，代价是暂停维修。' }
				await writeFile(join(workspaceDir, task.writeFiles[0]), JSON.stringify(data))
			}
		}
	})
	assert.equal(result.status, 'ready')
	assert.equal(result.repairCount, 1)
	assert.equal(reviews, 2)
	assert.deepEqual(result.changedFiles, [issue.filePath])
	assert.equal((await loadScenes(workspaceDir))[1].raw, original[1].raw)
})

test('持续不通过时最多返工两次，之后进入人工检查', async (t) => {
	const workspaceDir = await workspace(t)
	let repairs = 0
	let reviews = 0
	const result = await runReviewLoop({
		workspaceDir,
		log() {},
		async delegate(task) {
			if (task.assignee === 'continuity-reviewer') {
				reviews += 1
				await writeFile(join(workspaceDir, task.writeFiles[0]), JSON.stringify(failedReview))
			} else {
				const data = { ...original[2].data, title: `仍有问题的版本 ${++repairs}` }
				await writeFile(join(workspaceDir, task.writeFiles[0]), JSON.stringify(data))
			}
		}
	})
	assert.equal(result.status, 'needs_human_review')
	assert.equal(repairs, 2)
	assert.equal(reviews, 3)
})

test('不完整报告或审核期间文件变化，都不能放行', async (t) => {
	const workspaceDir = await workspace(t)
	await assert.rejects(() => runReviewLoop({
		workspaceDir, log() {},
		delegate: (task) => writeFile(join(workspaceDir, task.writeFiles[0]), '{"verdict":"approved"}')
	}))
	await assert.rejects(() => runReviewLoop({
		workspaceDir, log() {},
		async delegate(task) {
			await writeFile(join(workspaceDir, task.writeFiles[0]), JSON.stringify(passedReview))
			await writeFile(join(workspaceDir, issue.filePath), JSON.stringify({ ...original[2].data, title: '审核时被改动' }))
		}
	}), /审核期间/)
})

test('结构错误直接停止，不启动模型审核', async (t) => {
	const workspaceDir = await workspace(t)
	await writeFile(join(workspaceDir, issue.filePath), '{}')
	await assert.rejects(() => runReviewLoop({
		workspaceDir, log() {},
		delegate() { assert.fail('不应调用模型') }
	}), /结构校验失败/)
})
