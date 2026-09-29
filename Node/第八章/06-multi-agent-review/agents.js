import { createDeepAgent, FilesystemBackend } from 'deepagents'
import { createMiddleware } from 'langchain'

const roles = {
	'continuity-reviewer': {
		description: '对照世界规则审核场景正文，输出含原文引用的 JSON 问题报告。',
		systemPrompt: `你是剧情一致性审核者。读取任务单指定的 Skill、规则、场景和报告 Schema。
逐项核对场景正文与世界规则。关注明确冲突，不因个人审美要求返工，也不推测文件没有提供的设备属性。
同一个根本问题只记录一次。修改建议也必须符合全部世界规则，禁止建议等待外部救援或恢复对外通信。
只审核任务单指定的当前文件，不参考之前的审核结论。
问题引用 quote 必须逐字摘录对应文件 content 字段中的原文。
存在冲突时 verdict 为 needs_revision；没有冲突时为 approved 且 issues 为空。
将纯 JSON 报告写入指定路径。只写审核报告，保持游戏文件不变。
最终只回复报告路径和问题数量。`
	},
	'scene-writer': {
		description: '根据审核问题，只修复被授权场景的标题和正文。',
		systemPrompt: `你是场景编写者。读取任务单指定的 Skill、世界规则、场景和审核报告。
仅修改 writeFiles 中的文件，只修改 title 和 content，保留 id、ending、choices。
根据问题原因进行实质修改，保留这个选择原有的收益和代价，不要把两个结局改成相同结果。
输出符合 scene.schema.json 的纯 JSON 文件，完成后重新读取核对。
最终只回复修改文件路径和修改摘要。`
	}
}

/** 通过总导演的 task 工具调用指定角色；工作流决定本次委派的目标和权限。 */
export async function delegateTask(model, workspaceDir, assignment, signal) {
	// 从任务单中获取：
	// assignee：本次需要调用的子 Agent 角色
	// writeFiles：该角色允许修改的文件范围
	const { assignee, writeFiles } = assignment

	// 根据角色名称获取对应的 Agent 配置
	const role = roles[assignee]

	// 防止任务单指定不存在的执行角色
	if (!role) {
		throw new Error(`未知执行角色：${assignee}`)
	}

	// 标记总导演是否真正调用过 task 工具
	// 用于防止模型只回复文字，没有实际委派任务
	let dispatched = false

	// 创建总导演 Agent：
	// 总导演本身不直接修改文件，只负责根据任务单调用对应子 Agent
	const director = await createDeepAgent({
		model,

		// 所有 Agent 共享同一个 Workspace，
		// 子 Agent 可以读取上下文并修改授权文件
		backend: new FilesystemBackend({
			rootDir: workspaceDir,
			virtualMode: true
		}),

		// 总导演默认禁止写文件：
		// 防止总导演绕过子 Agent 直接修改产物
		permissions: [
			{
				operations: ['write'],
				paths: ['/**'],
				mode: 'deny'
			}
		],

		// 注册可被总导演调用的子 Agent
		subagents: [
			{
				// 当前委派目标名称，例如：
				// continuity-reviewer / scene-writer
				name: assignee,

				// 加载对应角色能力描述
				...role,

				// 子 Agent 使用独立上下文执行任务
				mode: 'isolated',

				// 加载所有可用 Skill
				skills: ['/skills/'],

				// 子 Agent 的文件权限：
				// 只允许修改当前任务指定的文件
				permissions: [
					{
						operations: ['write'],
						paths: writeFiles,
						mode: 'allow'
					},

					// 默认拒绝其他所有写操作
					{
						operations: ['write'],
						paths: ['/**'],
						mode: 'deny'
					}
				],

				// 添加执行过程追踪中间件
				middleware: [
					createMiddleware({
						name: 'WorkerTrace',

						// 包装工具调用：
						// 输出子 Agent 使用了什么工具、操作了哪个文件
						wrapToolCall: async (request, handler) => {
							const call = request.toolCall

							console.log(
								`[${assignee}] ${call.name} ${call.args.file_path ?? ''}`
							)

							return handler(request)
						}
					})
				]
			}
		],

		// 总导演系统提示词：
		// 明确限制它只能完成“委派”职责
		systemPrompt: `
你是总导演。当前处于已确定的检查或返工阶段。
将收到的完整 JSON 任务单原样作为 description，
使用 task 委派给其中的 assignee，
等待完成后简短回复。

本阶段只调用一次 task，无需使用其他工具。
下一阶段由程序根据实际文件决定。
`,

		// 总导演工具调用边界控制
		middleware: [
			createMiddleware({
				name: 'DelegationBoundary',

				wrapToolCall: async (request, handler) => {
					const call = request.toolCall

					// 强制限制：
					// 1. 必须调用 task 工具
					// 2. 必须调用指定角色
					// 3. 整个阶段只能委派一次
					if (
						call.name !== 'task' ||
						call.args.subagent_type !== assignee ||
						dispatched
					) {
						throw new Error('本阶段只允许向指定角色委派一次任务。')
					}

					dispatched = true

					console.log(`\n[总导演] task → ${assignee}`)

					// 使用程序传入的原始任务单覆盖模型生成的 description：
					// 避免模型转述任务时遗漏：
					// - 修改范围
					// - 验收条件
					// - 文件限制
					return handler({
						...request,
						toolCall: {
							...call,
							args: {
								...call.args,
								description: JSON.stringify(assignment)
							}
						}
					})
				}
			})
		]
	})

	// 启动总导演执行：
	// 总导演收到任务后，只负责调用 task，
	// 具体工作由对应子 Agent 完成
	await director.invoke(
		{
			messages: [
				{
					role: 'user',
					content: JSON.stringify(assignment)
				}
			]
		},
		{
			// 限制 Agent 最大递归调用深度，
			// 防止子 Agent 无限嵌套调用
			recursionLimit: 40,

			// 支持外部中断，例如超时取消
			signal
		}
	)

	// 如果总导演没有真正调用 task，
	// 说明任务没有被执行，直接终止流程
	if (!dispatched) {
		throw new Error('总导演没有实际委派任务，停止交付。')
	}
}
