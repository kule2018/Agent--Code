import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { assertOutline, assertReview, assertScene, gameFromOutline, validateGame } from './contracts.js'
import { replayBrief, replayCharacters, replayOutline, replayScenes, replayWorld, replayReport, defectQuote } from './replay.js'
import { availableChoices, choose, currentScene, startGame } from '../../shared/engine.js'

test('Replay 的分支和三个结局均实际可达', () => {
  assertOutline(replayBrief, replayOutline, replayCharacters)
  const game = gameFromOutline(replayBrief, replayOutline, replayCharacters, replayScenes(false))
  const paths = validateGame(game)
  assert.equal(Object.keys(paths).length, 3)
  assert.ok(Object.values(paths).every((path) => path.length > 0))
})

test('前面的选择改变控制室可用选项', () => {
  const game = gameFromOutline(replayBrief, replayOutline, replayCharacters, replayScenes(false))
  const start = startGame(game)
  const withKey = choose(game, choose(game, start, 'repair'), 'control')
  const withoutKey = choose(game, choose(game, start, 'medical'), 'control')
  assert.ok(availableChoices(currentScene(game, withKey), withKey.flags).some((item) => item.id === 'restart'))
  assert.ok(!availableChoices(currentScene(game, withoutKey), withoutKey.flags).some((item) => item.id === 'restart'))
})

test('无效目标、未知状态和不可达结局不能发布', () => {
  const base = gameFromOutline(replayBrief, replayOutline, replayCharacters, replayScenes(false))
  assert.throws(() => validateGame({ ...base, scenes: base.scenes.map((scene) => scene.id === 'scene-01' ? { ...scene, choices: [{ ...scene.choices[0], to: 'missing' }, scene.choices[1]] } : scene) }), /不存在/)
  assert.throws(() => validateGame({ ...base, scenes: base.scenes.map((scene) => scene.id === 'scene-04' ? { ...scene, choices: scene.choices.map((choice) => ({ ...choice, when: { unavailable: true } })) } : scene) }), /未知状态/)
  assert.throws(() => validateGame({ ...base, scenes: base.scenes.filter((scene) => scene.id !== 'ending-03') }), /不存在/)
})

test('场景必须保留批准的大纲分支，字段顺序变化不影响比较', () => {
  const value = replayScenes(false)[0]
  assertScene(replayOutline, { ...value, choices: value.choices.map(({ id, text, to, when, effects }) => ({ id, to, text, effects, when })) }, value.id)
  assert.throws(() => assertScene(replayOutline, { ...value, choices: [{ ...value.choices[0], to: 'ending-01' }, value.choices[1]] }, value.id), /分支结构/)
})

test('审核报告必须引用真实的场景原文', () => {
  const defect = replayScenes(true)
  assert.ok(defect.find((scene) => scene.id === 'ending-02')?.content.includes(defectQuote))
  assert.equal(assertReview(replayReport(true), defect).issues.length, 1)
  assert.throws(() => assertReview({ verdict: 'needs_revision', issues: [{ ...replayReport(true).issues[0], quote: '不存在的原文' }] }, defect), /引用了不存在/)
})
