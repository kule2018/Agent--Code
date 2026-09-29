import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { availableChoices, choose, currentScene, startGame, type Game, type Scene } from '../../shared/engine.js'

const Id = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)
const FlagValues = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,30}$/), z.boolean())

export const BriefSchema = z.object({
  title: z.string().trim().min(2).max(80),
  premise: z.string().trim().min(10).max(1000),
  genre: z.string().trim().min(2).max(30),
  audience: z.string().trim().min(2).max(80),
  worldRules: z.string().trim().min(10).max(1000),
  characterCount: z.number().int().min(2).max(4),
  sceneCount: z.number().int().min(6).max(10),
  endingCount: z.number().int().min(2).max(3),
  mode: z.enum(['replay', 'ai']),
  replayScenario: z.enum(['normal', 'defect']).default('normal')
}).strict().refine((value) => value.endingCount < value.sceneCount, '结局数必须少于场景总数。')
export type Brief = z.infer<typeof BriefSchema>

export const WorldSchema = z.object({
  title: z.string().min(2),
  summary: z.string().min(20),
  rules: z.array(z.string().min(8)).min(2).max(8)
}).strict()
export type World = z.infer<typeof WorldSchema>

const CharacterSchema = z.object({
  id: Id, name: z.string().min(1), goal: z.string().min(8), motivation: z.string().min(8)
}).strict()
export const CharactersSchema = z.object({ characters: z.array(CharacterSchema).min(2).max(4) }).strict()
export type Characters = z.infer<typeof CharactersSchema>

export const ChoiceSchema = z.object({
  id: Id, text: z.string().min(2), to: Id,
  when: FlagValues.default({}), effects: FlagValues.default({})
}).strict()
export const OutlineSceneSchema = z.object({
  id: Id, summary: z.string().min(8), characterIds: z.array(Id).min(1),
  ending: z.boolean(), choices: z.array(ChoiceSchema).max(3)
}).strict()
export const OutlineSchema = z.object({
  title: z.string().min(2), startSceneId: Id,
  flags: FlagValues, scenes: z.array(OutlineSceneSchema).min(6).max(10)
}).strict()
export type Outline = z.infer<typeof OutlineSchema>

export const SceneSchema = z.object({
  id: Id, title: z.string().min(2), content: z.string().min(30),
  ending: z.boolean(), choices: z.array(ChoiceSchema).max(3)
}).strict()
export const GameSchema = z.object({
  title: z.string().min(2), premise: z.string().min(10), startSceneId: Id,
  flags: FlagValues, characters: z.array(CharacterSchema),
  scenes: z.array(SceneSchema)
}).strict()

export const ReviewSchema = z.object({
  verdict: z.enum(['approved', 'needs_revision']),
  issues: z.array(z.object({
    filePath: z.string().regex(/^\/scenes\/[a-z][a-z0-9-]{1,31}\.json$/),
    rule: z.string().min(3), quote: z.string().min(3),
    reason: z.string().min(8), suggestion: z.string().min(8)
  }).strict()).max(10)
}).strict()
export type Review = z.infer<typeof ReviewSchema>

export function gameFromOutline(brief: Brief, outline: Outline, characters: Characters, scenes: Scene[]): Game {
  return {
    title: outline.title, premise: brief.premise, startSceneId: outline.startSceneId,
    flags: outline.flags, characters: characters.characters, scenes
  }
}

export function assertOutline(brief: Brief, outline: Outline, characters: Characters): void {
  if (outline.scenes.length !== brief.sceneCount) throw new Error(`场景数应为 ${brief.sceneCount}。`)
  if (characters.characters.length !== brief.characterCount) throw new Error(`角色数应为 ${brief.characterCount}。`)
  if (outline.scenes.filter((scene) => scene.ending).length !== brief.endingCount) {
    throw new Error(`结局数应为 ${brief.endingCount}。`)
  }
  const characterIds = new Set(characters.characters.map((character) => character.id))
  if (characterIds.size !== characters.characters.length) throw new Error('角色 ID 重复。')
  for (const scene of outline.scenes) {
    if (scene.characterIds.some((id) => !characterIds.has(id))) throw new Error(`${scene.id} 引用了不存在的角色。`)
  }
  const game = gameFromOutline(brief, outline, characters, outline.scenes.map((scene) => ({
    id: scene.id, title: scene.id, content: scene.summary.padEnd(30, '。'), ending: scene.ending, choices: scene.choices
  })))
  validateGame(game)
}

export function assertScene(outline: Outline, value: unknown, expectedId: string): Scene {
  const scene = SceneSchema.parse(value)
  const planned = outline.scenes.find((item) => item.id === expectedId)
  if (!planned || scene.id !== expectedId) throw new Error(`场景 ID 不符合任务要求：${expectedId}`)
  if (scene.ending !== planned.ending || !isDeepStrictEqual(scene.choices, planned.choices)) {
    throw new Error(`${expectedId} 修改了已批准的分支结构。`)
  }
  return scene
}

/** 同时验证分支结构和带状态条件的实际可达路线。 */
export function validateGame(game: Game): Record<string, string[]> {
  GameSchema.parse(game)
  const byId = new Map(game.scenes.map((scene) => [scene.id, scene]))
  if (byId.size !== game.scenes.length) throw new Error('场景 ID 重复。')
  if (Object.keys(game.flags).length > 3) throw new Error('状态变量最多三个。')
  const knownFlags = new Set(Object.keys(game.flags))
  const endingCount = game.scenes.filter((scene) => scene.ending).length
  if (!byId.has(game.startSceneId) || byId.get(game.startSceneId)?.ending) throw new Error('起点必须是普通场景。')
  if (!endingCount) throw new Error('至少需要一个结局。')
  for (const scene of game.scenes) {
    if (scene.ending ? scene.choices.length !== 0 : scene.choices.length < 2) {
      throw new Error(`${scene.id} 的选项数量不符合规则。`)
    }
    const choiceIds = new Set<string>()
    for (const choice of scene.choices) {
      if (choiceIds.has(choice.id)) throw new Error(`${scene.id} 的选项 ID 重复。`)
      choiceIds.add(choice.id)
      if (!byId.has(choice.to)) throw new Error(`${scene.id} 指向不存在的场景 ${choice.to}。`)
      for (const key of [...Object.keys(choice.when), ...Object.keys(choice.effects)]) {
        if (!knownFlags.has(key)) throw new Error(`${scene.id} 使用了未知状态 ${key}。`)
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`剧情包含循环：${id}。`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const choice of byId.get(id)!.choices) visit(choice.to)
    visiting.delete(id)
    visited.add(id)
  }
  visit(game.startSceneId)
  if (visited.size !== game.scenes.length) throw new Error('存在从开场无法到达的场景。')

  const paths: Record<string, string[]> = {}
  const queue = [{ session: startGame(game), path: [] as string[] }]
  const seen = new Set<string>()
  const reached = new Set<string>()
  while (queue.length) {
    const { session, path } = queue.shift()!
    const key = `${session.sceneId}:${JSON.stringify(Object.keys(game.flags).sort().map((flag) => session.flags[flag]))}`
    if (seen.has(key)) continue
    seen.add(key)
    reached.add(session.sceneId)
    const scene = currentScene(game, session)
    if (scene.ending) {
      paths[scene.id] = path
      continue
    }
    const options = availableChoices(scene, session.flags)
    if (!options.length) throw new Error(`${scene.id} 在某个可达状态下没有可选项。`)
    for (const choice of options) queue.push({
      session: choose(game, session, choice.id), path: [...path, `${scene.id}:${choice.id}`]
    })
  }
  if (reached.size !== game.scenes.length) throw new Error('存在因状态条件永远无法进入的场景。')
  if (Object.keys(paths).length !== endingCount) throw new Error('存在无法实际到达的结局。')
  return paths
}

export function assertReview(value: unknown, scenes: Scene[]): Review {
  const report = ReviewSchema.parse(value)
  if ((report.verdict === 'approved') !== (report.issues.length === 0)) throw new Error('审核结论与问题列表不一致。')
  for (const issue of report.issues) {
    const scene = scenes.find((item) => `/scenes/${item.id}.json` === issue.filePath)
    if (!scene || !scene.content.includes(issue.quote)) throw new Error(`审核报告引用了不存在的场景原文：${issue.filePath}`)
  }
  return report
}
