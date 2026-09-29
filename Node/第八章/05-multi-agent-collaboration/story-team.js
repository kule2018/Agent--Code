import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatDeepSeek } from '@langchain/deepseek'
import { createDeepAgent, FilesystemBackend } from 'deepagents'
import {
	createTraceMiddleware,
	messageText,
	printMainMessages
} from './trace.js'

const workspaceDir = fileURLToPath(new URL('./workspace/', import.meta.url))
const outputPath = '/game/branch-outline.md'

/** 创建总导演及剧情设计师，将用户需求交给真实模型完成委派和文件交付。 */
async function main() {
	// 检查模型调用所需的 API Key 是否存在。
	if (!process.env.DEEPSEEK_API_KEY) {
		throw new Error('请在 .env 中配置 DEEPSEEK_API_KEY。')
	}

	// 初始化大语言模型，作为后续 Agent 的推理核心。
	const model = new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 1,
		timeout: 120_000
	})

	// 创建 Agent 使用的文件系统后端。
	// Workspace 作为 Agent 的共享工作空间，用于保存世界观、Skill 和最终产物。
	const backend = new FilesystemBackend({
		rootDir: workspaceDir,
		virtualMode: true
	})

	// 保存本次运行过程中的调用轨迹，用于后续验证：
	// 1. 总导演是否正确委派子 Agent；
	// 2. 子 Agent 是否读取了必要文件；
	// 3. 子 Agent 内部消息是否泄漏到主 Agent。
	const trace = { inputs: new Map(), calls: [] }

	// 创建剧情设计师子 Agent。
	// 它负责具体执行剧情设计任务，总导演只负责拆解和协调。
	const plotDesigner = {
		name: 'plot-designer',

		// 描述当前子 Agent 的能力边界，
		// 帮助总导演判断什么时候应该调用该 Agent。
		description:
			'根据已有世界观设计剧情分支和不同结局，将 Markdown 大纲写入指定文件。',

		// 子 Agent 专属系统提示词。
		// 约束它的职责范围：读取世界观、使用 Skill、生成文件，而不是直接回答用户。
		systemPrompt: `你是互动剧情游戏的剧情设计师。
按照适用 Skill 完成收到的子任务，读取世界观并遵守其中的限制。
文件已经存在时，先读取，再根据本次任务决定修改或复用，完成后重新读取核对。
最终只返回交付文件路径和两个分支的简短说明，报告控制在 150 字以内，不要返回大纲全文。`,

		// isolated 表示该子 Agent 拥有独立执行环境。
		// 它有自己的上下文，不会直接共享主 Agent 的消息历史。
		mode: 'isolated',

		// 子 Agent 可使用的 Skill。
		// 例如剧情分支设计规则、模板等能力。
		skills: ['/skills/'],

		// 限制子 Agent 文件操作权限。
		// 只允许写入最终交付文件，禁止修改其他 Workspace 内容。
		permissions: [
			{
				operations: ['write'],
				paths: [outputPath],
				mode: 'allow'
			},
			{
				operations: ['write'],
				paths: ['/**'],
				mode: 'deny'
			}
		],

		// 添加调用追踪中间件，记录子 Agent 的 Tool 调用过程。
		middleware: [createTraceMiddleware('plot-designer', trace)]
	}

	// 创建总导演 Agent。
	// 总导演不负责具体创作，而负责理解需求、选择子 Agent、汇总结果。
	const director = await createDeepAgent({
		name: 'story-director',

		// 使用统一模型服务。
		model,

		// 使用共享 Workspace。
		backend,

		// 注册可调用的子 Agent。
		subagents: [plotDesigner],

		// 总导演职责说明。
		// 明确要求它只负责委派，不直接参与剧情生成。
		systemPrompt: `你是互动剧情制作的总导演。本次案例只负责委派和汇报。
使用 task 工具委派给 plot-designer。description 简洁保留用户的完整创作要求、世界观路径和交付文件路径。
剧情设计师会自行读取世界观和 Skill；你直接委派，无需调用文件工具，无需增加剧情细节或另一套设计步骤。
收到交付报告后，向用户简短说明交付位置和分支区别。`,

		// 禁止总导演直接写文件。
		// 体现 Supervisor 只负责协调，不执行具体任务。
		permissions: [
			{
				operations: ['write'],
				paths: ['/**'],
				mode: 'deny'
			}
		],

		// 记录总导演自身的调用过程。
		middleware: [createTraceMiddleware('story-director', trace)]
	})

	// 用户真实提交给系统的任务。
	// 总导演收到后，需要判断应该交给哪个子 Agent 完成。
	const userTask = `请根据 /game/world.md，为失联太空站游戏设计一个两难处境，
提供两个有不同后果的选择和对应结局。
将 Markdown 大纲保存到 ${outputPath}。`

	console.log('本次用户任务：\n', userTask)

	// 调用总导演 Agent。
	// recursionLimit 控制最大递归调用次数，防止 Agent 无限循环。
	// timeout 限制整个任务最长执行时间。
	const result = await director.invoke(
		{
			messages: [
				{
					role: 'user',
					content: userTask
				}
			]
		},
		{
			recursionLimit: 40,
			signal: AbortSignal.timeout(300_000)
		}
	)

	// 输出主 Agent 的对话过程。
	printMainMessages(result.messages)

	// 输出最终返回给用户的内容。
	console.log('\n总导演最终回答：\n', messageText(result.messages.at(-1)))

	// ==========================
	// 以下代码用于验证 Agent 执行是否符合预期
	// ==========================

	// 验证总导演是否调用 task 工具成功委派给剧情设计师。
	const delegated = trace.calls.some(
		(call) =>
			call.actor === 'story-director' &&
			call.name === 'task' &&
			call.args.subagent_type === 'plot-designer' &&
			call.ok
	)

	// 获取剧情设计师产生的所有 Tool 调用记录。
	const childCalls = trace.calls.filter(
		(call) => call.actor === 'plot-designer'
	)

	// 检查剧情设计师是否读取了任务要求中的关键文件：
	// 1. Skill 规则
	// 2. 剧情模板
	// 3. 世界观
	// 4. 最终输出文件
	for (const path of [
		'/skills/branch-story-design/SKILL.md',
		'/skills/branch-story-design/references/outline-template.md',
		'/game/world.md',
		outputPath
	]) {
		if (
			!childCalls.some(
				(call) =>
					call.name === 'read_file' && call.args.file_path === path && call.ok
			)
		) {
			throw new Error(`剧情设计师没有成功读取 ${path}，请核对调用记录。`)
		}
	}

	// 如果没有发生委派，说明 Supervisor 模式没有正确运行。
	if (!delegated) {
		throw new Error('本轮没有完成预期的剧情设计师委派。')
	}

	// 检查子 Agent 的内部 ToolMessage 是否泄漏到总导演上下文。
	// 正常情况下，主 Agent 只能看到子 Agent 返回的最终结果，
	// 不应该看到子 Agent 内部所有工具调用细节。
	const childIds = new Set(childCalls.map((call) => call.id))

	const leaked = result.messages.some((message) =>
		childIds.has(message.tool_call_id)
	)

	if (leaked) {
		throw new Error('主 Agent messages 中出现了子 Agent 内部工具结果。')
	}

	console.log('\n子 Agent 的内部 ToolMessage 是否进入总导演 messages：否')

	// ==========================
	// 验证最终文件是否真实生成
	// ==========================

	// 将虚拟路径转换为实际磁盘路径。
	const diskPath = join(workspaceDir, outputPath.slice(1))

	// 读取最终交付文件。
	const content = await readFile(diskPath, 'utf8')

	// 文件为空说明子 Agent 没有完成交付。
	if (!content.trim()) {
		throw new Error('交付文件为空。')
	}

	console.log('\n实际文件：', diskPath)
	console.log('\n大纲正文：\n', content)
}

main().catch((error) => {
	console.error(error.message)
	process.exitCode = 1
})
