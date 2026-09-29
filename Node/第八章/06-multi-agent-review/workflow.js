import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	SCENE_FILES,
	loadScenes,
	validateScenes,
	validateReview,
	checkRepairScope
} from './contracts.js'

/** 始终从实际文件验收；最多返工两次，通过后才标记 ready。 */
export async function runReviewLoop({
	workspaceDir,
	delegate,
	maxRepairs = 2,
	log = console.log
}) {
	// 记录当前已经执行的返工次数
	let repairCount = 0

	// 保存所有实际发生修改的文件，用于最终结果追踪
	const changedFiles = new Set()

	while (true) {
		// 每一轮都重新读取 Workspace 中的真实文件，
		// 避免依赖旧状态，确保审核基于当前磁盘内容
		const scenes = await loadScenes(workspaceDir)

		// 第一层检查：验证文件结构是否合法
		// 例如 JSON 格式、字段完整性、数据类型等
		const errors = validateScenes(scenes)

		if (errors.length) {
			throw new Error(`结构校验失败：${JSON.stringify(errors)}`)
		}

		log(`\n[程序校验] 第 ${repairCount + 1} 轮：三个场景、两个结局，结构通过。`)

		// 每一次审核生成独立报告文件：
		// 第一轮 review-1.json，第二轮 review-2.json ...
		const reportPath = `/reviews/review-${repairCount + 1}.json`

		// 创建审核任务，交给一致性审核 Agent
		const reviewTask = {
			// 指定负责审核的 Agent
			assignee: 'continuity-reviewer',

			// 审核目标：
			// 判断当前剧情是否违反世界规则
			goal: '检查各场景是否违反世界规则，保存逐条问题；无明确冲突时通过。',

			// 审核 Agent 可以读取的文件：
			// 世界观、所有场景、审核结果格式约束
			readFiles: [
				'/game/world.md',
				...SCENE_FILES,
				'/contracts/review.schema.json'
			],

			// 审核结果只能写入报告文件，
			// 防止审核 Agent 直接修改剧情内容
			writeFiles: [reportPath],

			// 加载对应审核规范 Skill
			skillPath: '/skills/story-quality/SKILL.md',

			// 定义审核结果必须满足的标准
			acceptanceCriteria: [
				'按 review.schema.json 交付报告，quote 原样引用场景正文。',
				'问题必须说明违反什么规则、影响哪个文件、建议怎样修改。',
				'只审核当前文件，保持世界观和场景不变。'
			]
		}

		// 执行审核任务
		await delegate(reviewTask)

		// 审核完成后，再次读取场景文件
		const afterReview = await loadScenes(workspaceDir)

		// 检查审核阶段是否偷偷修改了剧情文件
		// 审核 Agent 只允许生成报告，不允许修改场景
		if (afterReview.some((entry, index) => entry.raw !== scenes[index].raw)) {
			throw new Error('审核期间场景被修改，当前报告不能用于放行。')
		}

		// 读取并校验审核报告
		// 确保报告格式正确，并且引用的问题确实存在于当前场景
		const report = validateReview(
			JSON.parse(
				await readFile(join(workspaceDir, reportPath.slice(1)), 'utf8')
			),
			scenes
		)

		log(`[审核报告] ${report.verdict}，问题数：${report.issues.length}`)

		// 输出每一个发现的问题，方便观察 Agent 的审核过程
		for (const issue of report.issues) {
			log(
				`${issue.filePath}\n原文：${issue.quote}\n原因：${issue.reason}\n建议：${issue.suggestion}`
			)
		}

		// 如果审核通过，或者已经超过最大返工次数，
		// 结束流程，不再继续调用 Agent
		if (report.verdict === 'approved' || repairCount >= maxRepairs) {
			const result = {
				// approved 表示验收通过
				// 超过返工次数仍失败，则交给人工处理
				status: report.verdict === 'approved' ? 'ready' : 'needs_human_review',

				// 记录累计返工次数
				repairCount,

				// 保存最终使用的审核报告
				reportPath,

				// 保存所有发生变化的文件列表
				changedFiles: [...changedFiles]
			}

			// 写入最终执行结果
			await writeFile(
				join(workspaceDir, 'result.json'),
				JSON.stringify(result, null, 2)
			)

			log(`\n[最终状态] ${result.status}；已返工 ${repairCount} 次。`)

			return result
		}

		// 提取审核报告中实际受到影响的文件
		// 后续只允许修改这些文件，实现局部返工
		const affectedFiles = [
			...new Set(report.issues.map((issue) => issue.filePath))
		]

		// 创建剧情修复任务，交给场景编写 Agent
		const repairTask = {
			assignee: 'scene-writer',

			// 修复目标：
			// 解决违反世界规则的问题，同时保持剧情分支设计
			goal: '根据审核报告修复明确冲突，保留各分支的不同后果。',

			// 修复 Agent 可以读取：
			// 世界观、场景、审核报告、场景格式约束
			readFiles: [
				'/game/world.md',
				...SCENE_FILES,
				reportPath,
				'/contracts/scene.schema.json'
			],

			// 只能修改审核指出的问题文件
			writeFiles: affectedFiles,

			skillPath: '/skills/story-quality/SKILL.md',

			// 修复完成后的验收要求
			acceptanceCriteria: [
				'只修改授权文件的 title 和 content，保留 id、ending、choices。',
				'保留两个选择的收益和代价，不增加外部救援。',
				'其他文件保持不变，保存合法 JSON 并重新读取核对。'
			]
		}

		log(`\n[局部返工] 允许修改：${affectedFiles.join(', ')}`)

		// 执行局部修复
		await delegate(repairTask)

		// 修复完成后重新读取所有场景，
		// 检查 Agent 是否只修改了授权范围内的文件
		const afterRepair = await loadScenes(workspaceDir)

		const changed = checkRepairScope(scenes, afterRepair, affectedFiles)

		// 累计记录实际发生修改的文件
		for (const path of changed) {
			changedFiles.add(path)
		}

		log(`[修改核对] 实际变化：${changed.join(', ')}；其余场景原文保持不变。`)

		// 进入下一轮审核
		repairCount += 1
	}
}
