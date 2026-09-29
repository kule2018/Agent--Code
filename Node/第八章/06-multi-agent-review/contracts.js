import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

export const SCENE_FILES = [
	'/game/scenes/scene-01.json',
	'/game/scenes/ending-a.json',
	'/game/scenes/ending-b.json'
]

export const SceneSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	content: z.string().min(1),
	ending: z.boolean(),
	choices: z.array(z.object({
		text: z.string().min(1),
		nextSceneId: z.string().min(1)
	}).strict())
}).strict()

export const ReviewSchema = z.object({
	verdict: z.enum(['approved', 'needs_revision']),
	issues: z.array(z.object({
		filePath: z.enum(SCENE_FILES),
		rule: z.string().min(1),
		quote: z.string().min(1),
		reason: z.string().min(1),
		suggestion: z.string().min(1)
	}).strict()).max(10)
}).strict()

/** 只读取本例固定的场景清单，保留原文供局部修改前后比较。 */
export async function loadScenes(workspaceDir) {
	const entries = []
	for (const filePath of SCENE_FILES) {
		const raw = await readFile(join(workspaceDir, filePath.slice(1)), 'utf8')
		try {
			entries.push({ filePath, raw, data: JSON.parse(raw) })
		} catch {
			throw new Error(`${filePath} 不是合法 JSON，停止交付。`)
		}
	}
	return entries
}

/** 校验固定的三场景、双结局结构；当前教学游戏明确禁止循环分支。 */
export function validateScenes(entries) {
	const issues = []
	const add = (filePath, rule, reason) => issues.push({ filePath, rule, reason })
	for (const entry of entries) {
		const parsed = SceneSchema.safeParse(entry.data)
		if (!parsed.success) add(entry.filePath, 'schema', parsed.error.issues[0].message)
	}
	if (issues.length) return issues

	const byId = new Map()
	for (const { filePath, data } of entries) {
		if (byId.has(data.id)) add(filePath, 'duplicate_id', `场景 ID 重复：${data.id}`)
		byId.set(data.id, { filePath, data })
		if (data.ending && data.choices.length) add(filePath, 'ending_choices', '结局不能继续提供选项。')
		if (!data.ending && !data.choices.length) add(filePath, 'dead_end', '非结局场景必须有选项。')
	}
	if (!byId.has('scene-01')) add(SCENE_FILES[0], 'missing_start', '缺少起始场景 scene-01。')
	if (entries.filter(({ data }) => data.ending).length !== 2) {
		add('/game/scenes', 'ending_count', '本次要求恰好两个结局。')
	}
	for (const { filePath, data } of entries) {
		for (const choice of data.choices) {
			if (!byId.has(choice.nextSceneId)) {
				add(filePath, 'missing_target', `选项指向不存在的场景：${choice.nextSceneId}`)
			}
		}
	}
	if (issues.length) return issues

	const visited = new Set()
	const visiting = new Set()
	function visit(id) {
		if (visiting.has(id)) {
			add(byId.get(id).filePath, 'cycle', '本例要求有限分支，不能形成循环。')
			return
		}
		if (visited.has(id)) return
		visited.add(id)
		visiting.add(id)
		for (const choice of byId.get(id).data.choices) visit(choice.nextSceneId)
		visiting.delete(id)
	}
	visit('scene-01')
	for (const { filePath, data } of entries) {
		if (!visited.has(data.id)) add(filePath, 'unreachable', `从开场无法到达 ${data.id}。`)
	}
	return issues
}

/** 验证审核结论和问题列表一致，且引用来自本次审核的真实正文。 */
export function validateReview(value, entries) {
	const report = ReviewSchema.parse(value)
	if ((report.verdict === 'approved') !== (report.issues.length === 0)) {
		throw new Error('审核结论与问题列表不一致，停止交付。')
	}
	for (const issue of report.issues) {
		const entry = entries.find((item) => item.filePath === issue.filePath)
		if (!entry?.data.content.includes(issue.quote)) {
			throw new Error(`审核报告引用了正文中不存在的内容：${issue.filePath}`)
		}
	}
	return report
}

/** 本轮只允许调整问题文件的标题和正文；其余文件原文与分支结构保持不变。 */
export function checkRepairScope(before, after, allowedFiles) {
	const changed = []
	for (const old of before) {
		const current = after.find((entry) => entry.filePath === old.filePath)
		if (!current) throw new Error(`返工删除了场景：${old.filePath}`)
		if (old.raw === current.raw) continue
		if (!allowedFiles.includes(old.filePath)) throw new Error(`修改了未授权文件：${old.filePath}`)
		const structure = ({ id, ending, choices }) => ({ id, ending, choices })
		if (JSON.stringify(structure(old.data)) !== JSON.stringify(structure(current.data))) {
			throw new Error(`本次正文返工不允许改变分支结构：${old.filePath}`)
		}
		changed.push(old.filePath)
	}
	if (!changed.length) throw new Error('返工没有产生文件变化，停止继续消耗模型调用。')
	return changed
}
