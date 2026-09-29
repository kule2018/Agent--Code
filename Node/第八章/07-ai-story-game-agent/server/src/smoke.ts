import 'dotenv/config'
import { strict as assert } from 'node:assert'
import { replayBrief, defectQuote } from './replay.js'
import { validateGame } from './contracts.js'
import type { Game } from '../../shared/engine.js'

const base = process.env.STORY_BASE_URL ?? 'http://127.0.0.1:4311'
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/projects${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  const value = await response.json()
  if (!response.ok) throw new Error(JSON.stringify(value))
  return value as T
}
async function waitFor(id: string, states: string[]): Promise<any> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const project = await api<any>(`/${id}`)
    if (states.includes(project.status)) return project
    if (project.status === 'failed') throw new Error(`项目失败：${project.failure}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待项目 ${id} 超时。`)
}

for (const scenario of ['normal', 'defect'] as const) {
  const created = await api<{ id: string }>('', { ...replayBrief, replayScenario: scenario })
  const id = created.id
  const pending = await waitFor(id, ['awaiting_outline_review'])
  assert.equal(pending.outlineVersion, 1)
  await api(`/${id}/outline-review`, { outlineVersion: 1, decision: 'approve' })
  const ready = await waitFor(id, ['ready'])
  const game = await api<Game>(`/${id}/releases/${ready.latestReleaseId}/game`)
  const paths = validateGame(game)
  assert.equal(Object.keys(paths).length, 3)
  assert.equal(ready.repairCount, scenario === 'defect' ? 1 : 0)
  assert.ok(!game.scenes.some((scene) => scene.content.includes(defectQuote)))
  const offline = await fetch(`${base}/api/projects/${id}/releases/${ready.latestReleaseId}/download`).then((response) => response.text())
  assert.ok(offline.includes('data:image/jpeg;base64,'))
  assert.ok(offline.includes('StoryEngine.startGame(game)'))
  if (scenario === 'defect') {
    const events = await api<{ kind: string }[]>(`/${id}/events`)
    assert.ok(events.some((event) => event.kind === 'repair_completed'))
    const before = game.scenes.find((scene) => scene.id === 'scene-01')!.content
    await api(`/${id}/revise-scene`, { sceneId: 'scene-01', instruction: '让这里的气氛更紧张' })
    const revised = await waitFor(id, ['ready'])
    assert.equal(revised.revision, 2)
    assert.equal(revised.releaseIds.length, 2)
    const next = await api<Game>(`/${id}/releases/${revised.latestReleaseId}/game`)
    const old = await api<Game>(`/${id}/releases/${ready.latestReleaseId}/game`)
    assert.notEqual(next.scenes.find((scene) => scene.id === 'scene-01')!.content, before)
    assert.equal(old.scenes.find((scene) => scene.id === 'scene-01')!.content, before)
    assert.equal(next.scenes.find((scene) => scene.id === 'scene-02')!.content, game.scenes.find((scene) => scene.id === 'scene-02')!.content)
    validateGame(next)
  }
  console.log(`${scenario}: ${id}，3 个结局，返工 ${ready.repairCount} 轮，Release ${ready.latestReleaseId}`)
}

const changed = await api<{ id: string }>('', { ...replayBrief })
const versionOne = await waitFor(changed.id, ['awaiting_outline_review'])
await api(`/${changed.id}/outline-review`, { outlineVersion: 1, decision: 'revise', feedback: '让结局的代价更明确' })
let versionTwo: any
for (let i = 0; i < 120; i++) {
  const candidate = await api<any>(`/${changed.id}`)
  if (candidate.status === 'failed') throw new Error(candidate.failure)
  if (candidate.status === 'awaiting_outline_review' && candidate.outlineVersion === 2) { versionTwo = candidate; break }
  await new Promise((resolve) => setTimeout(resolve, 250))
}
assert.equal(versionTwo?.outlineVersion, 2)
assert.notEqual(
  versionTwo.outline.scenes.find((scene: any) => scene.id === 'ending-01').summary,
  versionOne.outline.scenes.find((scene: any) => scene.id === 'ending-01').summary
)
await assert.rejects(() => api(`/${changed.id}/outline-review`, { outlineVersion: 1, decision: 'approve' }), /Outline v2/)
await api(`/${changed.id}/outline-review`, { outlineVersion: 2, decision: 'approve' })
assert.equal((await waitFor(changed.id, ['ready'])).status, 'ready')
console.log(`outline revision: ${changed.id}，旧版本审核被拒绝，Outline v2 发布成功`)
