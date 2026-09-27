import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatDeepSeek } from '@langchain/deepseek'
import { createDeepAgent, FilesystemBackend } from 'deepagents'

const workspaceDir = fileURLToPath(new URL('./workspace/', import.meta.url))
const outputPath = '/game/branch-outline.md'
const skillPath = '/skills/branch-story-design/SKILL.md'
const templatePath =
	'/skills/branch-story-design/references/outline-template.md'

const tasks = {
	story: `请根据 /game/world.md，为失联太空站游戏设计一个两难处境，
提供两个有不同后果的选择和对应结局。
将 Markdown 大纲保存到 ${outputPath}。`,
	chat: '2 + 3 等于多少？直接给出答案。'
}

/** 统一提取 Message 正文，供终端展示和工具结果检查使用。 */
function messageText(message) {
	if (typeof message?.content === 'string') return message.content
	return (message?.content ?? [])
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
}

/** 按 Tool Call ID 配对请求与返回，避免把一次失败的读取当成已加载。 */
function collectToolCalls(messages) {
	const results = new Map(
		messages
			.filter((message) => message.tool_call_id)
			.map((message) => [message.tool_call_id, message])
	)
	return messages.flatMap((message) =>
		(message.tool_calls ?? []).map((call) => {
			const result = results.get(call.id)
			const text = messageText(result)
			return {
				name: call.name,
				path: call.args?.file_path,
				ok:
					Boolean(result) &&
					result.status !== 'error' &&
					!/^Error:/i.test(text),
				text
			}
		})
	)
}

/** 展示真正执行过的工具，以及本轮是否读入 Skill 正文和模板。 */
function printRun(result, calls) {
	console.log(
		'\n发现的 Skill：',
		(result.skillsMetadata ?? []).map((skill) => skill.name).join(', ') || '无'
	)
	console.log('\n本次工具调用：')
	if (calls.length === 0) console.log('无')
	for (const call of calls) {
		console.log(
			`${call.name}${call.path ? ` ${call.path}` : ''}：${call.ok ? '成功' : '失败'}`
		)
		if (!call.ok) console.log(call.text)
	}
	for (const [label, path] of [
		['Skill 正文', skillPath],
		['大纲模板', templatePath]
	]) {
		const read = calls.some(
			(call) => call.name === 'read_file' && call.path === path && call.ok
		)
		console.log(`\n本轮是否读取 ${label}：${read ? '是' : '否'}`)
	}
	console.log('\n最终回答：\n', messageText(result.messages.at(-1)))
}

/** 从命令选择任务，交给同一个 Deep Agent 配置完成。 */
async function main() {
	// 读取命令行参数，默认执行 story 任务
	const mode = process.argv[2] ?? 'story'

	// 当前示例只支持 story 和 chat 两种任务
	if (!Object.hasOwn(tasks, mode))
		throw new Error('仅支持 story 和 chat 两个命令。')

	// DeepSeek API Key 是模型调用的必要配置
	if (!process.env.DEEPSEEK_API_KEY)
		throw new Error('请在 .env 中配置 DEEPSEEK_API_KEY。')

	// 创建 DeepSeek 模型，限制重试次数和单次模型请求超时时间
	const model = new ChatDeepSeek({
		model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
		temperature: 0,
		maxRetries: 1,
		timeout: 120_000
	})

	// 把本地 workspace 目录作为 Agent 的文件系统工作区
	const backend = new FilesystemBackend({
		rootDir: workspaceDir,
		virtualMode: true
	})

	// 创建 Deep Agent。
	// story 和 chat 共用同一套模型、Workspace、Skills 和权限配置，
	// 具体执行什么任务由后面传入的用户消息决定。
	const agent = await createDeepAgent({
		model,
		backend,

		// 向 Agent 暴露 /skills/ 下的 Skill
		skills: ['/skills/'],

		systemPrompt:
			'你是互动剧情制作助手。当前任务由你直接完成，按用户要求交付。',

		// 本例只允许修改最终交付文件。
		// 其他文件（例如世界观、Skill、模板）保持只读。
		permissions: [
			{ operations: ['write'], paths: [outputPath], mode: 'allow' },
			{ operations: ['write'], paths: ['/**'], mode: 'deny' }
		]
	})

	console.log('本次任务：\n', tasks[mode])

	// 把当前命令对应的任务作为用户消息交给 Agent 执行。
	// recursionLimit 限制 Agent 最大递归执行次数，
	// AbortSignal 则限制整次任务最长执行 5 分钟。
	const result = await agent.invoke(
		{
			messages: [{ role: 'user', content: tasks[mode] }]
		},
		{ recursionLimit: 30, signal: AbortSignal.timeout(300_000) }
	)

	// 从完整消息记录中提取工具调用，方便检查 Agent 实际执行过程
	const calls = collectToolCalls(result.messages)
	printRun(result, calls)

	// story 任务需要额外检查最终大纲文件是否真正完成交付
	if (mode === 'story') {
		// 判断本轮是否成功写入或修改了目标大纲文件
		const saved = calls.some(
			(call) =>
				['write_file', 'edit_file'].includes(call.name) &&
				call.path === outputPath &&
				call.ok &&
				/Successfully (wrote|replaced)/.test(call.text)
		)

		// 判断 Agent 是否重新读取目标文件，对最终结果进行复核
		const reviewed = calls.some(
			(call) => call.name === 'read_file' && call.path === outputPath && call.ok
		)

		// 如果既没有保存，也没有复核目标文件，
		// 说明本轮没有完成预期的大纲交付流程
		if (!saved && !reviewed)
			throw new Error('本轮没有保存或复核大纲，请检查上面的调用记录。')

		// 将虚拟路径转换为真实磁盘路径，并读取最终文件内容
		const diskPath = join(workspaceDir, outputPath.slice(1))
		const content = await readFile(diskPath, 'utf8')

		// 防止出现工具执行成功，但最终文件内容为空的情况
		if (!content.trim()) throw new Error('大纲文件为空。')

		// 如果本轮没有重新写入，说明 Agent 复用了已有的大纲文件
		if (!saved) console.log('\n本轮只读取了已有大纲，没有重新写入文件。')

		// 输出实际保存位置和最终大纲内容，确认真正的文件交付结果
		console.log('\n实际文件：', diskPath)
		console.log('\n大纲正文：\n', content)
	}
}

main().catch((error) => {
	console.error(error.message)
	process.exitCode = 1
})
