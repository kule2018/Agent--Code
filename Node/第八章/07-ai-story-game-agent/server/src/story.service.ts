import {
	BadRequestException,
	ConflictException,
	Inject,
	Injectable,
	OnModuleDestroy,
	OnModuleInit
} from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import {
	Annotation,
	Command,
	END,
	interrupt,
	START,
	StateGraph
} from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import {
	BriefSchema,
	CharactersSchema,
	OutlineSchema,
	ReviewSchema,
	WorldSchema,
	assertOutline,
	assertReview,
	assertScene,
	gameFromOutline
} from './contracts.js'
import { AgentExecutionService, type Assignment, type Role } from './agents.js'
import { GameBuilderService } from './builder.js'
import { type Project } from './project.js'
import { ProjectRepository, DEFAULT_POSTGRES_URI } from './repository.js'
import { replayBrief } from './replay.js'
import { WorkspaceService } from './workspace.js'
import type { Scene } from '../../shared/engine.js'

const Flow = Annotation.Root({
	projectId: Annotation<string>(),
	decision: Annotation<'approve' | 'revise' | 'reject'>(),
	feedback: Annotation<string>()
})
type FlowState = typeof Flow.State
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const stopped = new Set(['cancelled', 'failed', 'ready'])

/** LangGraph 管阶段；项目、任务和文件由应用持久化并独立验收。 */
@Injectable()
export class StoryService implements OnModuleInit, OnModuleDestroy {
	private readonly saver = PostgresSaver.fromConnString(
		process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI
	)
	private graph: any
	private readonly running = new Map<string, AbortController>()
	private readonly pendingReviews = new Set<string>()
	private shuttingDown = false

	constructor(
		@Inject(ProjectRepository) private readonly repo: ProjectRepository,
		@Inject(WorkspaceService) private readonly workspace: WorkspaceService,
		@Inject(AgentExecutionService)
		private readonly agents: AgentExecutionService,
		@Inject(GameBuilderService) private readonly builder: GameBuilderService
	) {}

	async onModuleInit(): Promise<void> {
		await this.repo.setup()
		await this.saver.setup()
		this.graph = this.createGraph()
		for (const project of await this.repo.list()) {
			if (
				!stopped.has(project.status) &&
				project.status !== 'awaiting_outline_review' &&
				project.status !== 'needs_human_review'
			) {
				setImmediate(() => void this.run(project.id, null))
			}
		}
	}

	async onModuleDestroy(): Promise<void> {
		this.shuttingDown = true
		for (const controller of this.running.values()) controller.abort()
		await this.saver.end()
	}

	private config(id: string) {
		return { configurable: { thread_id: id }, recursionLimit: 35 }
	}

	private createGraph() {
		const graph = new StateGraph(Flow)
			.addNode('world', async (state) => {
				await this.prepareWorld(state.projectId)
				return {}
			})
			.addNode('outline', async (state) => {
				await this.prepareOutline(state.projectId, state.feedback ?? '')
				return { feedback: '' }
			})
			.addNode('approval', async (state) => {
				// 等待用户对当前版本大纲进行人工审核。
				const project = await this.repo.get(state.projectId)

				// 中断当前 Graph 执行，向外部请求人工审批。
				// 流程会停在这里，直到收到 approve / revise / reject 三种决策之一。
				const answer = interrupt({
					type: 'outline_review',
					outlineVersion: project.outlineVersion
				}) as {
					decision: 'approve' | 'revise' | 'reject'
					feedback?: string
				}

				if (answer.decision === 'approve') {
					// 用户批准当前版本大纲：
					// 记录已批准版本，并进入场景编写阶段。
					await this.patch(state.projectId, {
						approvedOutlineVersion: project.outlineVersion,
						status: 'writing_scenes'
					})

					await this.emit(
						state.projectId,
						'outline_approved',
						`Outline v${project.outlineVersion} 已批准`
					)
				} else if (answer.decision === 'revise') {
					// 用户要求修改：
					// 大纲版本号递增，清空当前大纲，
					// 重新进入大纲设计阶段，后续会基于 feedback 生成新版本。
					await this.patch(state.projectId, {
						outlineVersion: project.outlineVersion + 1,
						outline: null,
						status: 'designing_outline'
					})

					await this.emit(
						state.projectId,
						'outline_revision',
						`根据反馈生成 Outline v${project.outlineVersion + 1}`,
						{ feedback: answer.feedback }
					)
				} else {
					// 用户直接拒绝当前大纲：
					// 将项目标记为取消，并终止后续制作流程。
					await this.patch(state.projectId, {
						status: 'cancelled'
					})

					await this.emit(
						state.projectId,
						'cancelled',
						'用户拒绝大纲，制作停止'
					)
				}

				// 将人工审核结果返回给 Graph，
				// 后续节点可以根据 decision 决定继续、返工或结束流程。
				return {
					decision: answer.decision,
					feedback: answer.feedback ?? ''
				}
			})
			.addNode('scenes', async (state) => {
				await this.prepareScenes(state.projectId)
				return {}
			})
			.addNode('review', async (state) => {
				await this.reviewAndRelease(state.projectId)
				return {}
			})
			.addEdge(START, 'world')
			.addEdge('world', 'outline')
			.addEdge('outline', 'approval')
			.addConditionalEdges('approval', (state) => state.decision, {
				approve: 'scenes',
				revise: 'outline',
				reject: END
			})
			.addEdge('scenes', 'review')
			.addEdge('review', END)
		return graph.compile({ checkpointer: this.saver })
	}

	/** 校验制作要求、创建项目，并异步启动制作流程。 */
	async create(input: unknown): Promise<Project> {
		// 校验并解析输入；不符合 Schema 的数据会直接抛出异常。
		const brief = BriefSchema.parse(input)

		// Replay 模式仅允许使用预设制作要求，但可以选择不同的演示场景。
		if (brief.mode === 'replay') {
			const expected = { ...replayBrief, replayScenario: brief.replayScenario }

			// 对比序列化后的配置，防止在预设演示中混入自定义制作要求。
			if (JSON.stringify(brief) !== JSON.stringify(expected)) {
				throw new BadRequestException(
					'Replay 只能使用预设的失联太空站制作要求；自定义创意请使用 AI 模式。'
				)
			}
		}

		const id = randomUUID()
		const now = new Date().toISOString()

		const project: Project = {
			// 项目基础信息；初次运行时，runId 与项目 ID 保持一致。
			id,
			runId: id,
			version: 1,
			revision: 1,
			mode: brief.mode,
			brief,

			// 项目先进入排队状态，世界观、角色和大纲等产物尚未生成。
			status: 'queued',
			world: null,
			characters: null,
			outline: null,
			outlineVersion: 1,

			// 大纲尚未获得批准，也没有审核结果或返工记录。
			approvedOutlineVersion: null,
			review: null,
			repairCount: 0,

			// 尚未发布，最新发布 ID 和历史发布列表均为空。
			latestReleaseId: null,
			releaseIds: [],

			// 初始化执行信息：没有失败记录，也没有正在执行的角色或任务。
			failure: null,
			activeRole: null,
			currentTask: null,
			tasks: [],

			createdAt: now,
			updatedAt: now
		}

		// 根据项目 ID、初始版本和制作要求，准备工作区。
		await this.workspace.prepare(id, 1, brief)

		// 保存项目初始记录，确保后续制作流程可以读取项目。
		await this.repo.create(project)

		// 发送创建事件，说明本次使用的是预设演示还是 AI 真实制作。
		await this.emit(
			id,
			'created',
			`${brief.mode === 'replay' ? 'Replay 预设演示' : 'AI 真实制作'}已开始`
		)

		// 将制作流程安排到后续事件循环执行，不在这里等待制作完成。
		// void 表示忽略 run 返回的 Promise，并不负责捕获异步异常。
		setImmediate(() => void this.run(id, { projectId: id }))

		// 返回刚创建的项目，调用方无需等待完整制作流程结束。
		return project
	}

	/**
	 * 审核大纲，用户可以选择批准、修改或拒绝当前版本。
	 */
	async reviewOutline(
		id: string,
		input: {
			outlineVersion: number
			decision: 'approve' | 'revise' | 'reject'
			feedback?: string
		}
	): Promise<void> {
		// 防止同一个项目的审核请求被重复提交。
		if (this.pendingReviews.has(id))
			throw new ConflictException('审核请求正在处理，请稍后刷新。')

		// 获取当前项目最新状态。
		const project = await this.repo.get(id)

		// 只有项目处于“等待大纲审核”阶段时，才允许提交审核结果。
		if (project.status !== 'awaiting_outline_review')
			throw new ConflictException('当前不在大纲审核阶段。')

		// 校验前端提交的大纲版本是否仍然是当前待审核版本，
		// 避免用户基于旧页面误审批已经失效的大纲。
		if (project.outlineVersion !== input.outlineVersion)
			throw new ConflictException(
				`当前待审核的是 Outline v${project.outlineVersion}。`
			)

		// 如果选择修改大纲，则必须提供具体修改意见。
		if (input.decision === 'revise' && !input.feedback?.trim())
			throw new BadRequestException('请填写修改意见。')

		// Replay 模式只支持预设的大纲修改场景，
		// 避免用户输入超出演示数据支持范围的自定义要求。
		if (
			project.mode === 'replay' &&
			input.decision === 'revise' &&
			!/代价|悬疑|紧张/.test(input.feedback ?? '')
		) {
			throw new BadRequestException(
				'Replay 只演示“明确结局代价”或“增加悬疑感”的大纲修改；自定义要求请使用 AI 模式。'
			)
		}

		// 读取当前 Graph 执行状态。
		const state = await this.graph.getState(this.config(id))

		// 确认工作流确实因为 approval 节点的 interrupt 而暂停，
		// 防止在错误的执行位置强行 resume。
		if (!state.next?.includes('approval'))
			throw new ConflictException('工作流没有停在大纲审核位置。')

		// 标记当前项目的审核请求正在处理中，避免重复恢复 Graph。
		this.pendingReviews.add(id)

		// 异步恢复之前被 interrupt 暂停的工作流，
		// 将用户的审批结果作为 resume 数据传回 approval 节点。
		setImmediate(
			() =>
				void this.run(id, new Command({ resume: input })).finally(() =>
					// 无论工作流执行成功还是失败，都释放审核锁。
					this.pendingReviews.delete(id)
				)
		)
	}

	async cancel(id: string): Promise<void> {
		const project = await this.repo.get(id)
		if (project.status === 'ready' || project.status === 'cancelled')
			throw new ConflictException('当前项目已结束。')
		this.running.get(id)?.abort()
		await this.patch(id, {
			status: 'cancelled',
			activeRole: null,
			currentTask: null
		})
		await this.emit(id, 'cancelled', '用户停止了当前制作')
	}

	async retry(id: string): Promise<void> {
		const project = await this.repo.get(id)
		if (!['failed', 'needs_human_review'].includes(project.status))
			throw new ConflictException('当前没有需要重试的任务。')
		// 请求失败只重试当前轮；用户主动继续人工处理状态时，才开启新一轮返工预算。
		await this.patch(id, {
			status: project.outline ? 'reviewing' : 'queued',
			failure: null,
			repairCount:
				project.status === 'needs_human_review' ? 0 : project.repairCount
		})
		if (project.status === 'needs_human_review') {
			setImmediate(
				() => void this.runDirect(id, () => this.reviewAndRelease(id))
			)
		} else {
			setImmediate(() => void this.run(id, null))
		}
	}

	async reviseScene(
		id: string,
		sceneId: string,
		instruction: string
	): Promise<void> {
		const project = await this.repo.get(id)
		if (project.status !== 'ready')
			throw new ConflictException('只有已发布的游戏可以局部改写。')
		if (!project.outline?.scenes.some((scene) => scene.id === sceneId))
			throw new BadRequestException('场景不存在。')
		if (instruction.trim().length < 4 || instruction.length > 500)
			throw new BadRequestException('修改要求应为 4～500 个字。')
		if (/增加场景|删除场景|改变分支|新增结局|世界规则/.test(instruction)) {
			throw new BadRequestException(
				'这项修改会改变大纲结构，需要重新规划，当前只支持单场景文字改写。'
			)
		}
		if (
			project.mode === 'replay' &&
			!/紧张|悬疑|压迫|对话|细节|更简洁/.test(instruction)
		) {
			throw new BadRequestException(
				'Replay 只演示固定的文字改写；请使用 AI 模式提交自定义要求。'
			)
		}
		await this.workspace.copyRevision(
			id,
			project.revision,
			project.revision + 1
		)
		await this.patch(id, {
			revision: project.revision + 1,
			status: 'writing_scenes',
			review: null,
			repairCount: 0
		})
		await this.emit(
			id,
			'scene_revision',
			`创建 Revision ${project.revision + 1}，只改写 ${sceneId}`,
			{ instruction }
		)
		setImmediate(
			() =>
				void this.runDirect(id, async () => {
					const current = await this.repo.get(id)
					await this.writeScene(current, sceneId, instruction, false)
					await this.reviewAndRelease(id)
				})
		)
	}

	/** 运行项目状态图，必要时补充启动流程所需的项目 ID。 */
	private async run(id: string, input: unknown): Promise<void> {
		// 将状态图的执行逻辑交给 runDirect 统一处理。
		await this.runDirect(id, async () => {
			// 读取当前项目对应的状态快照，检查状态中是否已有项目 ID。
			const snapshot = await this.graph.getState(this.config(id))

			// 当输入为 null，且状态中没有 projectId 时，补充启动输入。
			// 其他情况保留原输入，包括状态中已有 projectId 时传入的 null。
			const nextInput =
				input === null && !snapshot.values?.projectId
					? { projectId: id }
					: input

			// 使用当前项目的执行配置调用状态图，等待本次调用完成。
			await this.graph.invoke(nextInput, this.config(id))
		})
	}

	private async runDirect(
		id: string,
		work: () => Promise<unknown>
	): Promise<void> {
		if (this.running.has(id)) return
		const controller = new AbortController()
		this.running.set(id, controller)
		try {
			await work()
		} catch (error) {
			const project = await this.repo.get(id)
			if (project.status !== 'cancelled' && !this.shuttingDown) {
				const message = error instanceof Error ? error.message : String(error)
				await this.patch(id, {
					status: 'failed',
					failure: message,
					activeRole: null,
					currentTask: null
				})
				await this.emit(id, 'failed', message)
			}
		} finally {
			this.running.delete(id)
		}
	}

	private signal(id: string): AbortSignal {
		return this.running.get(id)?.signal ?? new AbortController().signal
	}

	private async ensureActive(id: string): Promise<void> {
		if (
			(await this.repo.get(id)).status === 'cancelled' ||
			this.signal(id).aborted
		)
			throw new Error('任务已取消。')
	}

	private async patch(id: string, patch: Partial<Project>): Promise<Project> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const project = await this.repo.get(id)
			try {
				return await this.repo.save({ ...project, ...patch })
			} catch (error) {
				if (!(error instanceof ConflictException) || attempt === 2) throw error
			}
		}
		throw new ConflictException('项目状态更新冲突。')
	}

	private async emit(
		id: string,
		kind: string,
		message: string,
		detail: Record<string, unknown> = {}
	): Promise<void> {
		await this.repo.event(id, kind, message, detail)
	}

	/**
	 * 为指定角色创建任务，定义输入、输出和验收标准。
	 */
	private async assignment(
		project: Project,
		role: Role,
		goal: string,
		reads: string[],
		names: string[],
		criteria: string[],
		extras: Partial<Assignment> = {}
	): Promise<Assignment> {
		const taskId = randomUUID()
		const writeFiles = await this.workspace.stage(project.id, taskId, names)
		const inputManifest: Record<string, string> = {}
		for (const path of reads)
			inputManifest[path] = hash(
				await this.workspace.readText(project.id, path)
			)
		return {
			taskId,
			projectId: project.id,
			revision: project.revision,
			assignee: role,
			goal,
			readFiles: reads,
			writeFiles,
			skillPath: `/skills/${
				(
					{
						'world-designer': 'world-building',
						'plot-architect': 'branch-story-design',
						'scene-writer': 'scene-writing',
						'continuity-reviewer': 'continuity-review'
					} as Record<Role, string>
				)[role]
			}/SKILL.md`,
			acceptanceCriteria: criteria,
			inputManifest,
			...extras
		}
	}

	/**
	 * 执行任务
	 */
	private async task<T>(
		project: Project,
		assignment: Assignment,
		destinations: string[],
		validate: (values: unknown[]) => T
	): Promise<T> {
		await this.ensureActive(project.id)
		const task = {
			id: assignment.taskId,
			role: assignment.assignee,
			status: 'running' as const,
			inputs: assignment.readFiles,
			outputs: destinations
		}
		const latest = await this.repo.get(project.id)
		await this.patch(project.id, {
			activeRole: assignment.assignee,
			currentTask: task.id,
			tasks: [...latest.tasks, task]
		})
		await this.emit(
			project.id,
			'task_started',
			`${assignment.assignee} 开始任务`,
			{ taskId: task.id, readFiles: task.inputs, writeFiles: task.outputs }
		)
		try {
			// 将任务交给 AgentExecutionService 执行，传入项目、任务、事件回调和中止信号。
			await this.agents.execute(
				project,
				assignment,
				(kind, message, detail) => this.emit(project.id, kind, message, detail),
				this.signal(project.id)
			)
			await this.ensureActive(project.id)
			// 读取任务交付文件并解析为 JSON 对象。
			const values = await Promise.all(
				assignment.writeFiles.map((path) =>
					this.workspace.readJson(project.id, path)
				)
			)
			console.log('values', values)

			// 调用 validate 回调函数对产物进行校验，返回解析后的结果。
			const result = validate(values)
			for (const [path, previousHash] of Object.entries(
				assignment.inputManifest
			)) {
				if (
					hash(await this.workspace.readText(project.id, path)) !== previousHash
				)
					throw new Error(`任务输入已变化：${path}`)
			}
			await this.ensureActive(project.id)
			// 将任务交付文件从暂存区移动到正式目录，确保产物可被后续流程访问。
			for (let i = 0; i < destinations.length; i++) {
				await this.workspace.promote(
					project.id,
					assignment.writeFiles[i],
					destinations[i]
				)
			}
			const current = await this.repo.get(project.id)
			await this.patch(project.id, {
				activeRole: null,
				currentTask: null,
				tasks: current.tasks.map((item) =>
					item.id === task.id ? { ...item, status: 'completed' } : item
				)
			})
			await this.emit(
				project.id,
				'task_completed',
				`${assignment.assignee} 的文件通过验收`,
				{ taskId: task.id, destinations }
			)
			return result
		} catch (error) {
			const current = await this.repo.get(project.id)
			await this.patch(project.id, {
				activeRole: null,
				currentTask: null,
				tasks: current.tasks.map((item) =>
					item.id === task.id
						? { ...item, status: 'failed', error: String(error) }
						: item
				)
			})
			throw error
		}
	}

	/** 设计世界观与人物档案，校验产物后保存到项目。 */
	private async prepareWorld(id: string): Promise<void> {
		// 读取项目；世界观和人物档案都已存在时，跳过本次设计。
		const project = await this.repo.get(id)
		if (project.world && project.characters) return

		// 更新项目状态，标记当前进入世界观设计阶段。
		await this.patch(id, { status: 'designing_world' })

		// 使用当前修订版本的目录，定位制作要求和本次交付文件。
		const base = `/revisions/${project.revision}`

		// 为世界观设计师构建任务，明确输入资料、交付文件和验收要求。
		const assignment = await this.assignment(
			project,
			'world-designer',
			'设计世界规则与人物档案',
			[
				// 制作要求提供创作背景，Schema 契约约束交付文件的结构。
				`${base}/brief.md`,
				`${base}/brief.json`,
				'/contracts/world.schema.json',
				'/contracts/characters.schema.json'
			],
			['world.json', 'characters.json'],
			['符合世界规则', '角色数量与制作要求一致']
		)

		// 将任务交给 task 执行，并指定预期产物路径和解析校验回调。
		const [world, characters] = await this.task(
			project,
			assignment,
			[`${base}/world.json`, `${base}/characters.json`],
			// 分别校验世界观和人物档案；任一产物不符合 Schema 时抛出异常。
			([rawWorld, rawCharacters]) =>
				[
					WorldSchema.parse(rawWorld),
					CharactersSchema.parse(rawCharacters)
				] as const
		)

		// Schema 校验后，再核对角色数量是否与本次制作要求一致。
		if (characters.characters.length !== project.brief.characterCount)
			throw new Error('角色数量不符合制作要求。')

		// 将通过上述校验的世界观和人物档案保存到项目记录。
		await this.patch(id, { world, characters })
	}

	/**
	 * 准备大纲
	 * @param id 当前作品 ID
	 * @param feedback 用户对大纲的修改意见
	 * @returns
	 */
	private async prepareOutline(id: string, feedback: string): Promise<void> {
		// 读取当前项目最新状态。
		const project = await this.repo.get(id)

		// 如果大纲已经生成，并且正在等待人工审核，则无需重复生成。
		if (project.outline && project.status === 'awaiting_outline_review') return

		// 标记项目进入“大纲设计中”状态。
		await this.patch(id, { status: 'designing_outline' })

		// 当前 revision 对应的 Workspace 基础目录。
		const base = `/revisions/${project.revision}`

		// 为剧情架构师创建本次大纲设计任务单，
		// 明确任务目标、可读取资料、交付文件以及验收要求。
		const assignment = await this.assignment(
			project,
			'plot-architect',
			`根据世界设定设计分支大纲。${feedback ? `用户修改意见：${feedback}` : ''}`,
			[
				`${base}/brief.md`,
				`${base}/world.json`,
				`${base}/characters.json`,
				'/contracts/outline.schema.json'
			],
			['outline.json'],
			['所有场景、结局和状态路径可达', '角色与场景数量符合要求']
		)

		// 执行剧情架构师任务，并将生成结果保存为当前版本的大纲文件。
		const outline = await this.task(
			project,
			assignment,
			[`${base}/outline-v${project.outlineVersion}.json`],

			// Agent 完成任务后，对交付结果进行两层校验：
			// 1. Schema 校验结构是否合法；
			// 2. 业务校验大纲是否满足当前项目要求。
			([raw]) => {
				const value = OutlineSchema.parse(raw)

				assertOutline(project.brief, value, project.characters!)

				return value
			}
		)

		// 校验通过后保存大纲，并进入“等待人工审核”状态。
		await this.patch(id, {
			outline,
			status: 'awaiting_outline_review'
		})

		// 通知前端当前版本大纲已经准备完成，可以进入人工审核。
		await this.emit(
			id,
			'outline_ready',
			`Outline v${project.outlineVersion} 等待人工审核`
		)
	}

	/**
	 * 准备场景
	 */
	private async prepareScenes(id: string): Promise<void> {
		// 获取当前项目最新状态。
		const project = await this.repo.get(id)

		// 只有当前大纲已经存在，并且当前版本已经通过人工审批，
		// 才允许进入场景生成阶段。
		if (
			!project.outline ||
			project.approvedOutlineVersion !== project.outlineVersion
		) {
			throw new Error('当前大纲尚未批准。')
		}

		// 将项目状态更新为“正在编写场景”。
		await this.patch(id, { status: 'writing_scenes' })

		// 按照已批准大纲中的场景列表，逐个准备场景产物。
		for (const scene of project.outline.scenes) {
			// 每生成一个场景前检查项目是否仍然处于可执行状态，
			// 避免项目被取消或终止后继续生成后续内容。
			await this.ensureActive(id)

			// 当前场景在 Workspace 中对应的产物路径。
			const path = `/revisions/${project.revision}/scenes/${scene.id}.json`

			try {
				// 尝试读取已经存在的场景文件，
				// 并校验它是否仍然符合当前大纲和场景定义。
				assertScene(
					project.outline,
					await this.workspace.readJson(id, path),
					scene.id
				)

				// 场景已经存在且校验通过，直接复用，
				// 不需要再次调用 Agent 生成。
				continue
			} catch {
				// 场景不存在、读取失败或校验不通过时，
				// 重新生成当前场景。
				await this.writeScene(project, scene.id, undefined, false)
			}
		}
	}

	/**
	 * 编写场景
	 */
	private async writeScene(
		project: Project,
		sceneId: string,
		instruction?: string,
		repair = false
	): Promise<void> {
		// 场景生成必须基于已经存在的大纲。
		if (!project.outline) throw new Error('没有已批准大纲。')

		// 当前 revision 对应的 Workspace 基础目录。
		const base = `/revisions/${project.revision}`

		// 场景编写时默认需要读取：
		// 用户需求、世界观、角色设定、已批准大纲以及场景 Schema。
		const reads = [
			`${base}/brief.md`,
			`${base}/world.json`,
			`${base}/characters.json`,
			`${base}/outline-v${project.outlineVersion}.json`,
			'/contracts/scene.schema.json'
		]

		// 如果是用户改写或审核返工，
		// 还需要读取当前场景原文，基于已有内容进行修改。
		if (repair || instruction) {
			reads.push(`${base}/scenes/${sceneId}.json`)
		}

		// 如果是审核返工，还需要读取上一轮审核报告，
		// 让 Scene Writer 根据具体问题定向修复。
		if (repair) {
			reads.push(`${base}/reviews/review-${project.repairCount - 1}.json`)
		}

		// 根据当前任务类型生成不同的执行目标：
		// repair：根据审核问题修复；
		// instruction：根据用户要求改写；
		// 默认：按照已批准大纲首次生成场景。
		const goal = repair
			? `根据审核问题修复 ${sceneId} 的正文，不修改任何其他场景。`
			: instruction
				? `按用户要求改写 ${sceneId}：${instruction}`
				: `按照已批准大纲编写 ${sceneId} 的正文。`

		// 为 Scene Writer 创建任务单，
		// 明确目标、可读取资料、交付文件以及验收要求。
		const assignment = await this.assignment(
			project,
			'scene-writer',
			goal,
			reads,
			[`${sceneId}.json`],
			['只写本场景标题与正文', '分支结构与批准大纲完全一致'],
			{
				sceneId,
				instruction
			}
		)

		// 执行场景编写任务，并将结果写入对应的场景文件。
		await this.task(
			project,
			assignment,
			[`${base}/scenes/${sceneId}.json`],

			// 对 Agent 生成结果进行校验，
			// 确保当前场景与已批准大纲中的结构保持一致。
			([raw]) => assertScene(project.outline!, raw, sceneId)
		)
	}

	/** 读取当前版本大纲中的全部场景文件，并逐个校验后返回。 */
	private async scenes(project: Project): Promise<Scene[]> {
		// 场景必须依赖大纲读取，否则无法确定应该加载哪些场景。
		if (!project.outline) throw new Error('大纲缺失。')

		const values: Scene[] = []

		// 按照大纲中的场景顺序，依次读取当前 revision 对应的场景文件。
		for (const item of project.outline.scenes)
			values.push(
				// 校验场景结构、ID 以及分支信息是否仍与已批准大纲保持一致。
				assertScene(
					project.outline,
					await this.workspace.readJson(
						project.id,
						`/revisions/${project.revision}/scenes/${item.id}.json`
					),
					item.id
				)
			)

		return values
	}

	/** 审核全部场景；审核不通过时只返工受影响场景，通过后生成正式发布版本。 */
	private async reviewAndRelease(id: string): Promise<void> {
		let project = await this.repo.get(id)

		// 一致性审核依赖已生成的大纲、角色以及已批准的大纲版本。
		if (
			!project.outline ||
			!project.characters ||
			!project.approvedOutlineVersion
		)
			throw new Error('构建依赖尚未齐全。')

		// 持续执行「审核 → 局部返工 → 再审核」，直到通过或达到自动返工上限。
		while (true) {
			await this.ensureActive(id)
			await this.patch(id, { status: 'reviewing' })

			project = await this.repo.get(id)
			const scenes = await this.scenes(project)
			const base = `/revisions/${project.revision}`

			// 收集当前大纲对应的全部场景文件，作为审核员的输入材料。
			const paths = project.outline!.scenes.map(
				(item) => `${base}/scenes/${item.id}.json`
			)

			// 创建一致性审核任务，要求审核结果必须能够引用真实场景内容作为依据。
			const assignment = await this.assignment(
				project,
				'continuity-reviewer',
				'检查全部场景是否违反世界设定或人物动机，给出有原文依据的审核报告',
				[
					`${base}/brief.md`,
					`${base}/world.json`,
					`${base}/characters.json`,
					`${base}/outline-v${project.outlineVersion}.json`,
					...paths,
					'/contracts/review.schema.json'
				],
				['review.json'],
				['问题引用必须来自真实场景正文', '无问题时 approved 且 issues 为空']
			)

			// 执行审核任务，并使用真实场景再次校验审核报告是否合法。
			const report = await this.task(
				project,
				assignment,
				[`${base}/reviews/review-${project.repairCount}.json`],
				([raw]) => assertReview(raw, scenes)
			)

			await this.patch(id, { review: report })

			// 将本轮审核结果通知给外部调用方。
			await this.emit(
				id,
				'review_completed',
				report.verdict === 'approved'
					? '剧情一致性审核通过'
					: `发现 ${report.issues.length} 个剧情问题`,
				{ issues: report.issues }
			)

			// 审核通过后退出返工循环，进入正式发布阶段。
			if (report.verdict === 'approved') break

			// 最多允许两轮自动返工，仍未通过则转交人工处理。
			if (project.repairCount >= 2) {
				await this.patch(id, {
					status: 'needs_human_review',
					failure: '自动返工已达到两轮，请人工检查。'
				})
				return
			}

			// 根据审核报告中的文件路径，只提取真正存在问题的场景 ID。
			const affected = [
				...new Set(
					report.issues.map((issue) =>
						issue.filePath.replace('/scenes/', '').replace('.json', '')
					)
				)
			]

			// 记录返工次数，并重新读取最新项目状态。
			await this.patch(id, { repairCount: project.repairCount + 1 })
			project = await this.repo.get(id)

			// 只重新生成受影响的场景，已经通过检查的场景保持不变。
			for (const sceneId of affected)
				await this.writeScene(project, sceneId, undefined, true)

			await this.emit(id, 'repair_completed', `只返工 ${affected.join('、')}`, {
				affected
			})
		}

		// 审核通过后，再次确认任务没有被取消或终止。
		await this.ensureActive(id)
		project = await this.repo.get(id)

		// 读取最终确认通过的全部场景，准备构建发布版本。
		const finished = await this.scenes(project)

		// 保存本次发布所依赖的完整源文件路径，便于后续追溯发布产物来源。
		const sourcePaths = [
			`/revisions/${project.revision}/world.json`,
			`/revisions/${project.revision}/characters.json`,
			`/revisions/${project.revision}/outline-v${project.outlineVersion}.json`,
			...project.outline!.scenes.map(
				(scene) => `/revisions/${project.revision}/scenes/${scene.id}.json`
			)
		]

		// 将世界观、角色、大纲和最终场景组装成完整游戏，并生成正式发布产物。
		const release = await this.builder.release(
			project,
			gameFromOutline(
				project.brief,
				project.outline!,
				project.characters!,
				finished
			),
			sourcePaths
		)

		await this.ensureActive(id)

		// 记录最新发布版本并将项目状态更新为可试玩、可下载。
		await this.patch(id, {
			latestReleaseId: release.id,
			releaseIds: [...project.releaseIds, release.id],
			status: 'ready',
			failure: null,
			activeRole: null
		})

		// 通知外部：当前版本已经正式发布，同时返回发布 ID 和所有结局路径。
		await this.emit(id, 'released', '游戏已通过检查，可以试玩与下载', {
			releaseId: release.id,
			endings: Object.keys(release.paths)
		})
	}
}
