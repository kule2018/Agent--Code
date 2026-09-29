import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatDeepSeek } from '@langchain/deepseek'
import { z } from 'zod'
import {
	SceneSchema,
	ReviewSchema,
	loadScenes,
	validateScenes
} from './contracts.js'
import { delegateTask } from './agents.js'
import { runReviewLoop } from './workflow.js'

/** 每次复制一份缺陷样本，保留之前运行的文件，并生成供 Agent 读取的格式规范。 */
async function prepareWorkspace() {
	const root = fileURLToPath(new URL('./workspaces/', import.meta.url))
	await mkdir(root, { recursive: true })
	const workspaceDir = await mkdtemp(join(root, 'run-'))
	await cp(
		fileURLToPath(new URL('./fixtures/', import.meta.url)),
		workspaceDir,
		{ recursive: true }
	)
	await mkdir(join(workspaceDir, 'reviews'))
	await mkdir(join(workspaceDir, 'contracts'))
	for (const [name, schema] of [
		['scene', SceneSchema],
		['review', ReviewSchema]
	]) {
		await writeFile(
			join(workspaceDir, 'contracts', `${name}.schema.json`),
			JSON.stringify(z.toJSONSchema(schema), null, 2)
		)
	}
	return workspaceDir
}

/** 从命令进入：准备样本，创建模型，再运行检查、返工和重新验收。 */
async function main() {
	// 读取命令参数：
	// demo：执行完整流程（模型审核 -> 定位问题 -> 委派修复 -> 重新验收）
	// validate：只执行本地结构校验，不调用模型
	const mode = process.argv[2] ?? 'demo'

	// 限制可执行模式，避免传入未知命令导致流程异常
	if (!['demo', 'validate'].includes(mode)) {
		throw new Error('只支持 demo 和 validate。')
	}

	// demo 模式需要调用真实模型，因此提前检查 API Key 是否配置
	if (mode === 'demo' && !process.env.DEEPSEEK_API_KEY) {
		throw new Error('请沿用前面小节，在 .env 中配置 DEEPSEEK_API_KEY。')
	}

	// 创建本次运行需要的 Workspace：
	// 初始化世界观、角色、场景等教学样本文件
	const workspaceDir = await prepareWorkspace()

	console.log('本次工作区：', workspaceDir)
	console.log(
		'教学样本：ending-b 的正文故意写入了“外部救援”，审核和修复由真实模型执行。'
	)

	// validate 模式只检查文件结构，例如字段是否缺失、格式是否正确
	// 不判断故事内容是否符合世界规则，这部分需要模型进行语义审核
	if (mode === 'validate') {
		const errors = validateScenes(await loadScenes(workspaceDir))

		console.log(
			errors.length
				? errors
				: '结构检查通过。故事是否符合世界规则，还需要语义审核。'
		)

		// 存在结构错误时，让命令行返回失败状态
		if (errors.length) process.exitCode = 1

		return
	}

	// 创建大语言模型实例，后续由 Agent 调用模型完成：
	// 1. 分析错误结局是否违反世界观
	// 2. 找出需要修改的文件
	// 3. 生成修复方案
	// 4. 重新检查修复结果
	const model = new ChatDeepSeek({
		// 默认使用教学环境中的模型，也支持通过环境变量覆盖
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',

		// 设置为 0，让审核和修复结果更加稳定、可复现
		temperature: 0,

		// 模型调用失败时最多自动重试一次
		maxRetries: 1,

		// 单次模型请求最长等待时间
		timeout: 120_000
	})

	// 为整个审核-修复流程设置最长执行时间：
	// 防止 Agent 因工具调用、模型重试等原因无限等待
	const signal = AbortSignal.timeout(600_000)

	// 启动完整闭环：
	// 检查结局 -> 定位违反规则的位置 -> 委派修改 -> 再次验收
	const result = await runReviewLoop({
		workspaceDir,

		// 将模型和 Workspace 注入任务委派函数，
		// 让后续审核 Agent 可以读取和修改对应文件
		delegate: (assignment) =>
			delegateTask(model, workspaceDir, assignment, signal)
	})

	// 保存整个流程结果，方便后续查看：
	// 包括发现的问题、修改记录、最终验收状态等
	console.log('结果记录：', join(workspaceDir, 'result.json'))

	// 如果最终没有达到 ready 状态，则标记命令执行失败
	if (result.status !== 'ready') {
		process.exitCode = 1
	}
}

main().catch((error) => {
	console.error('停止交付：', error.message)
	process.exitCode = 1
})
