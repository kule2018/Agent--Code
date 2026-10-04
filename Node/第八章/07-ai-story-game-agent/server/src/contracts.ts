import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import {
	availableChoices,
	choose,
	currentScene,
	startGame,
	type Game,
	type Scene
} from '../../shared/engine.js'

const Id = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/)
const FlagValues = z.record(
	z.string().regex(/^[a-z][a-zA-Z0-9]{0,30}$/),
	z.boolean()
)

export const BriefSchema = z
	.object({
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
	})
	.strict()
	.refine(
		(value) => value.endingCount < value.sceneCount,
		'结局数必须少于场景总数。'
	)
export type Brief = z.infer<typeof BriefSchema>

// 世界观数据结构：用于约束 Agent 最终生成的世界观内容。
export const WorldSchema = z
	.object({
		// 世界观标题，至少 2 个字符。
		title: z.string().min(2),

		// 世界观概要，避免生成过于简单的描述。
		summary: z.string().min(20),

		// 世界规则，要求 2～8 条，每条规则至少 8 个字符。
		rules: z.array(z.string().min(8)).min(2).max(8)
	})
	.strict()

// 根据 WorldSchema 自动推导 TypeScript 类型，保证类型定义与 Schema 始终一致。
export type World = z.infer<typeof WorldSchema>

// 单个角色的数据结构。
const CharacterSchema = z
	.object({
		// 角色唯一标识。
		id: Id,

		// 角色名称。
		name: z.string().min(1),

		// 角色当前希望达成的目标。
		goal: z.string().min(8),

		// 驱动角色采取行动的内在动机。
		motivation: z.string().min(8)
	})
	.strict()

// 角色列表：一个故事要求包含 2～4 个主要角色。
export const CharactersSchema = z
	.object({
		characters: z.array(CharacterSchema).min(2).max(4)
	})
	.strict()

// 根据 CharactersSchema 自动推导角色集合的 TypeScript 类型。
export type Characters = z.infer<typeof CharactersSchema>
export const ChoiceSchema = z
	.object({
		id: Id,
		text: z.string().min(2),
		to: Id,
		when: FlagValues.default({}),
		effects: FlagValues.default({})
	})
	.strict()
export const OutlineSceneSchema = z
	.object({
		id: Id,
		summary: z.string().min(8),
		characterIds: z.array(Id).min(1),
		ending: z.boolean(),
		choices: z.array(ChoiceSchema).max(3)
	})
	.strict()
export const OutlineSchema = z
	.object({
		title: z.string().min(2),
		startSceneId: Id,
		flags: FlagValues,
		scenes: z.array(OutlineSceneSchema).min(6).max(10)
	})
	.strict()
export type Outline = z.infer<typeof OutlineSchema>

export const SceneSchema = z
	.object({
		id: Id,
		title: z.string().min(2),
		content: z.string().min(30),
		ending: z.boolean(),
		choices: z.array(ChoiceSchema).max(3)
	})
	.strict()
export const GameSchema = z
	.object({
		title: z.string().min(2),
		premise: z.string().min(10),
		startSceneId: Id,
		flags: FlagValues,
		characters: z.array(CharacterSchema),
		scenes: z.array(SceneSchema)
	})
	.strict()

export const ReviewSchema = z
	.object({
		verdict: z.enum(['approved', 'needs_revision']),
		issues: z
			.array(
				z
					.object({
						filePath: z
							.string()
							.regex(/^\/scenes\/[a-z][a-z0-9-]{1,31}\.json$/),
						rule: z.string().min(3),
						quote: z.string().min(3),
						reason: z.string().min(8),
						suggestion: z.string().min(8)
					})
					.strict()
			)
			.max(10)
	})
	.strict()
export type Review = z.infer<typeof ReviewSchema>

/** 根据已确认的大纲、角色和场景数据，组装最终可发布的游戏对象。 */
export function gameFromOutline(
	brief: Brief,
	outline: Outline,
	characters: Characters,
	scenes: Scene[]
): Game {
	return {
		// 游戏标题直接使用已批准大纲中的标题。
		title: outline.title,

		// 保留最初需求中的故事前提，作为游戏整体背景。
		premise: brief.premise,

		// 指定玩家进入游戏后的第一个场景。
		startSceneId: outline.startSceneId,

		// 保留大纲中定义的状态标记，用于后续剧情分支判断。
		flags: outline.flags,

		// 提取最终确认的角色列表。
		characters: characters.characters,

		// 使用已经完成并通过审核的全部场景作为游戏正文。
		scenes
	}
}

export function assertOutline(
	brief: Brief,
	outline: Outline,
	characters: Characters
): void {
	if (outline.scenes.length !== brief.sceneCount)
		throw new Error(`场景数应为 ${brief.sceneCount}。`)
	if (characters.characters.length !== brief.characterCount)
		throw new Error(`角色数应为 ${brief.characterCount}。`)
	if (
		outline.scenes.filter((scene) => scene.ending).length !== brief.endingCount
	) {
		throw new Error(`结局数应为 ${brief.endingCount}。`)
	}
	const characterIds = new Set(
		characters.characters.map((character) => character.id)
	)
	if (characterIds.size !== characters.characters.length)
		throw new Error('角色 ID 重复。')
	for (const scene of outline.scenes) {
		if (scene.characterIds.some((id) => !characterIds.has(id)))
			throw new Error(`${scene.id} 引用了不存在的角色。`)
	}
	const game = gameFromOutline(
		brief,
		outline,
		characters,
		outline.scenes.map((scene) => ({
			id: scene.id,
			title: scene.id,
			content: scene.summary.padEnd(30, '。'),
			ending: scene.ending,
			choices: scene.choices
		}))
	)
	validateGame(game)
}

/**
 * 校验场景数据是否符合已批准的大纲要求。
 * @param outline 已批准的大纲
 * @param value Agent 生成的场景数据
 * @param expectedId 期望的场景 ID
 * @returns 校验通过的场景数据
 */
export function assertScene(
	outline: Outline,
	value: unknown,
	expectedId: string
): Scene {
	// 先通过 SceneSchema 校验场景数据结构，
	// 确保字段、类型以及基础约束全部合法。
	const scene = SceneSchema.parse(value)

	// 从已批准的大纲中找到当前任务对应的场景定义。
	const planned = outline.scenes.find((item) => item.id === expectedId)

	// 确认大纲中存在这个场景，
	// 并且 Agent 实际生成的场景 ID 与任务要求一致。
	if (!planned || scene.id !== expectedId) {
		throw new Error(`场景 ID 不符合任务要求：${expectedId}`)
	}

	// 场景正文可以重新生成或修改，
	// 但 ending 和 choices 属于已经批准的大纲结构，
	// Scene Writer 不允许擅自修改。
	if (
		scene.ending !== planned.ending ||
		!isDeepStrictEqual(scene.choices, planned.choices)
	) {
		throw new Error(`${expectedId} 修改了已批准的分支结构。`)
	}

	// 结构与业务约束都通过后，返回校验完成的场景数据。
	return scene
}

/**
 * 校验完整游戏的结构与可玩性：
 * 包括场景引用、状态变量、剧情连通性以及不同状态下的真实可达路径。
 */
export function validateGame(game: Game): Record<string, string[]> {
	// 先通过 Schema 校验 Game 的基础数据结构。
	GameSchema.parse(game)

	// 建立场景 ID 到场景对象的索引，方便后续快速检查跳转关系。
	const byId = new Map(game.scenes.map((scene) => [scene.id, scene]))

	// Map 数量变少说明存在重复的场景 ID。
	if (byId.size !== game.scenes.length) throw new Error('场景 ID 重复。')

	// 为了控制状态空间复杂度，本例最多允许三个状态变量。
	if (Object.keys(game.flags).length > 3) throw new Error('状态变量最多三个。')

	const knownFlags = new Set(Object.keys(game.flags))

	// 统计大纲中声明的结局场景数量。
	const endingCount = game.scenes.filter((scene) => scene.ending).length

	// 开场场景必须真实存在，并且不能直接是结局。
	if (!byId.has(game.startSceneId) || byId.get(game.startSceneId)?.ending)
		throw new Error('起点必须是普通场景。')

	// 一个完整游戏至少需要存在一个结局。
	if (!endingCount) throw new Error('至少需要一个结局。')

	// 逐个检查场景自身以及所有选项的静态约束。
	for (const scene of game.scenes) {
		// 结局场景不能继续提供选项；普通场景至少需要两个选择。
		if (scene.ending ? scene.choices.length !== 0 : scene.choices.length < 2) {
			throw new Error(`${scene.id} 的选项数量不符合规则。`)
		}

		const choiceIds = new Set<string>()

		for (const choice of scene.choices) {
			// 同一个场景中的选项 ID 必须唯一。
			if (choiceIds.has(choice.id))
				throw new Error(`${scene.id} 的选项 ID 重复。`)

			choiceIds.add(choice.id)

			// 每个选项的目标场景都必须真实存在。
			if (!byId.has(choice.to))
				throw new Error(`${scene.id} 指向不存在的场景 ${choice.to}。`)

			// when 和 effects 中只能使用游戏预先声明过的状态变量。
			for (const key of [
				...Object.keys(choice.when),
				...Object.keys(choice.effects)
			]) {
				if (!knownFlags.has(key))
					throw new Error(`${scene.id} 使用了未知状态 ${key}。`)
			}
		}
	}

	// 第一层连通性检查：只看场景之间的静态跳转关系，不考虑状态条件。
	const visiting = new Set<string>()
	const visited = new Set<string>()

	function visit(id: string): void {
		// 当前 DFS 路径中再次遇到同一个场景，说明剧情图存在循环。
		if (visiting.has(id)) throw new Error(`剧情包含循环：${id}。`)

		// 已经完整检查过的场景无需再次遍历。
		if (visited.has(id)) return

		visiting.add(id)

		// 沿当前场景的所有选项继续检查后续场景。
		for (const choice of byId.get(id)!.choices) visit(choice.to)

		visiting.delete(id)
		visited.add(id)
	}

	// 从游戏开场开始遍历整个剧情图。
	visit(game.startSceneId)

	// 如果还有未访问场景，说明它在静态结构上就无法从开场进入。
	if (visited.size !== game.scenes.length)
		throw new Error('存在从开场无法到达的场景。')

	// 第二层检查：真正模拟游戏状态，验证条件分支在运行时是否可达。
	const paths: Record<string, string[]> = {}

	// 队列中同时保存当前游戏 Session，以及到达该状态所经过的选择路径。
	const queue = [
		{
			session: startGame(game),
			path: [] as string[]
		}
	]

	// 同一个「场景 + 状态变量组合」只需要模拟一次。
	const seen = new Set<string>()

	// 记录实际运行过程中真正到达过的场景。
	const reached = new Set<string>()

	while (queue.length) {
		const { session, path } = queue.shift()!

		// 将当前场景和全部状态变量组合成唯一状态标识。
		const key = `${session.sceneId}:${JSON.stringify(
			Object.keys(game.flags)
				.sort()
				.map((flag) => session.flags[flag])
		)}`

		// 已经模拟过相同运行状态时直接跳过，避免重复搜索。
		if (seen.has(key)) continue

		seen.add(key)
		reached.add(session.sceneId)

		const scene = currentScene(game, session)

		// 到达结局后，保存一条可以真实走到该结局的选择路径。
		if (scene.ending) {
			paths[scene.id] = path
			continue
		}

		// 根据当前 flags 计算玩家此时真正可以选择的选项。
		const options = availableChoices(scene, session.flags)

		// 普通场景在任何可达状态下都必须至少存在一个可执行选项。
		if (!options.length)
			throw new Error(`${scene.id} 在某个可达状态下没有可选项。`)

		// 分别执行所有可选分支，将新状态加入后续搜索队列。
		for (const choice of options)
			queue.push({
				session: choose(game, session, choice.id),
				path: [...path, `${scene.id}:${choice.id}`]
			})
	}

	// 静态结构上虽然可达，但如果状态条件永远不满足，同样属于无效场景。
	if (reached.size !== game.scenes.length)
		throw new Error('存在因状态条件永远无法进入的场景。')

	// 每一个声明为 ending 的场景，都必须能够通过真实游戏状态实际到达。
	if (Object.keys(paths).length !== endingCount)
		throw new Error('存在无法实际到达的结局。')

	// 返回每个结局对应的一条有效选择路径，供发布和验证阶段使用。
	return paths
}

/** 校验审核报告：结论必须与问题数量一致，并且所有问题引用都必须来自真实场景原文。 */
export function assertReview(value: unknown, scenes: Scene[]): Review {
	// 先通过 Schema 校验审核报告的基础数据结构。
	const report = ReviewSchema.parse(value)

	// approved 必须对应零问题；存在任何问题时则不能判定为 approved。
	if ((report.verdict === 'approved') !== (report.issues.length === 0))
		throw new Error('审核结论与问题列表不一致。')

	// 逐条验证审核问题，防止模型编造不存在的场景或引用内容。
	for (const issue of report.issues) {
		// 根据审核报告中的文件路径找到对应场景。
		const scene = scenes.find(
			(item) => `/scenes/${item.id}.json` === issue.filePath
		)

		// 场景必须真实存在，并且 quote 必须能够在场景正文中找到。
		if (!scene || !scene.content.includes(issue.quote))
			throw new Error(`审核报告引用了不存在的场景原文：${issue.filePath}`)
	}

	return report
}
