import { BadRequestException, ConflictException, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID, createHash } from 'node:crypto'
import { Annotation, Command, END, interrupt, START, StateGraph } from '@langchain/langgraph'
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres'
import { BriefSchema, CharactersSchema, OutlineSchema, ReviewSchema, WorldSchema, assertOutline, assertReview, assertScene, gameFromOutline } from './contracts.js'
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
  private readonly saver = PostgresSaver.fromConnString(process.env.POSTGRES_URI ?? DEFAULT_POSTGRES_URI)
  private graph: any
  private readonly running = new Map<string, AbortController>()
  private readonly pendingReviews = new Set<string>()
  private shuttingDown = false

  constructor(
    @Inject(ProjectRepository) private readonly repo: ProjectRepository,
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
    @Inject(AgentExecutionService) private readonly agents: AgentExecutionService,
    @Inject(GameBuilderService) private readonly builder: GameBuilderService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.repo.setup()
    await this.saver.setup()
    this.graph = this.createGraph()
    for (const project of await this.repo.list()) {
      if (!stopped.has(project.status) && project.status !== 'awaiting_outline_review' && project.status !== 'needs_human_review') {
        setImmediate(() => void this.run(project.id, null))
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true
    for (const controller of this.running.values()) controller.abort()
    await this.saver.end()
  }

  private config(id: string) { return { configurable: { thread_id: id }, recursionLimit: 35 } }

  private createGraph() {
    const graph = new StateGraph(Flow)
      .addNode('world', async (state) => { await this.prepareWorld(state.projectId); return {} })
      .addNode('outline', async (state) => { await this.prepareOutline(state.projectId, state.feedback ?? ''); return { feedback: '' } })
      .addNode('approval', async (state) => {
        const project = await this.repo.get(state.projectId)
        const answer = interrupt({ type: 'outline_review', outlineVersion: project.outlineVersion }) as { decision: 'approve' | 'revise' | 'reject'; feedback?: string }
        if (answer.decision === 'approve') {
          await this.patch(state.projectId, { approvedOutlineVersion: project.outlineVersion, status: 'writing_scenes' })
          await this.emit(state.projectId, 'outline_approved', `Outline v${project.outlineVersion} 已批准`)
        } else if (answer.decision === 'revise') {
          await this.patch(state.projectId, { outlineVersion: project.outlineVersion + 1, outline: null, status: 'designing_outline' })
          await this.emit(state.projectId, 'outline_revision', `根据反馈生成 Outline v${project.outlineVersion + 1}`, { feedback: answer.feedback })
        } else {
          await this.patch(state.projectId, { status: 'cancelled' })
          await this.emit(state.projectId, 'cancelled', '用户拒绝大纲，制作停止')
        }
        return { decision: answer.decision, feedback: answer.feedback ?? '' }
      })
      .addNode('scenes', async (state) => { await this.prepareScenes(state.projectId); return {} })
      .addNode('review', async (state) => { await this.reviewAndRelease(state.projectId); return {} })
      .addEdge(START, 'world')
      .addEdge('world', 'outline')
      .addEdge('outline', 'approval')
      .addConditionalEdges('approval', (state) => state.decision, { approve: 'scenes', revise: 'outline', reject: END })
      .addEdge('scenes', 'review')
      .addEdge('review', END)
    return graph.compile({ checkpointer: this.saver })
  }

  async create(input: unknown): Promise<Project> {
    const brief = BriefSchema.parse(input)
    if (brief.mode === 'replay') {
      const expected = { ...replayBrief, replayScenario: brief.replayScenario }
      if (JSON.stringify(brief) !== JSON.stringify(expected)) {
        throw new BadRequestException('Replay 只能使用预设的失联太空站制作要求；自定义创意请使用 AI 模式。')
      }
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const project: Project = {
      id, runId: id, version: 1, revision: 1, mode: brief.mode, brief,
      status: 'queued', world: null, characters: null, outline: null, outlineVersion: 1,
      approvedOutlineVersion: null, review: null, repairCount: 0, latestReleaseId: null,
      releaseIds: [], failure: null, activeRole: null, currentTask: null, tasks: [],
      createdAt: now, updatedAt: now
    }
    await this.workspace.prepare(id, 1, brief)
    await this.repo.create(project)
    await this.emit(id, 'created', `${brief.mode === 'replay' ? 'Replay 预设演示' : 'AI 真实制作'}已开始`)
    setImmediate(() => void this.run(id, { projectId: id }))
    return project
  }

  async reviewOutline(id: string, input: { outlineVersion: number; decision: 'approve' | 'revise' | 'reject'; feedback?: string }): Promise<void> {
    if (this.pendingReviews.has(id)) throw new ConflictException('审核请求正在处理，请稍后刷新。')
    const project = await this.repo.get(id)
    if (project.status !== 'awaiting_outline_review') throw new ConflictException('当前不在大纲审核阶段。')
    if (project.outlineVersion !== input.outlineVersion) throw new ConflictException(`当前待审核的是 Outline v${project.outlineVersion}。`)
    if (input.decision === 'revise' && !input.feedback?.trim()) throw new BadRequestException('请填写修改意见。')
    if (project.mode === 'replay' && input.decision === 'revise' && !/代价|悬疑|紧张/.test(input.feedback ?? '')) {
      throw new BadRequestException('Replay 只演示“明确结局代价”或“增加悬疑感”的大纲修改；自定义要求请使用 AI 模式。')
    }
    const state = await this.graph.getState(this.config(id))
    if (!state.next?.includes('approval')) throw new ConflictException('工作流没有停在大纲审核位置。')
    this.pendingReviews.add(id)
    setImmediate(() => void this.run(id, new Command({ resume: input })).finally(() => this.pendingReviews.delete(id)))
  }

  async cancel(id: string): Promise<void> {
    const project = await this.repo.get(id)
    if (project.status === 'ready' || project.status === 'cancelled') throw new ConflictException('当前项目已结束。')
    this.running.get(id)?.abort()
    await this.patch(id, { status: 'cancelled', activeRole: null, currentTask: null })
    await this.emit(id, 'cancelled', '用户停止了当前制作')
  }

  async retry(id: string): Promise<void> {
    const project = await this.repo.get(id)
    if (!['failed', 'needs_human_review'].includes(project.status)) throw new ConflictException('当前没有需要重试的任务。')
    await this.patch(id, { status: project.outline ? 'reviewing' : 'queued', failure: null, repairCount: 0 })
    if (project.status === 'needs_human_review') {
      setImmediate(() => void this.runDirect(id, () => this.reviewAndRelease(id)))
    } else {
      setImmediate(() => void this.run(id, null))
    }
  }

  async reviseScene(id: string, sceneId: string, instruction: string): Promise<void> {
    const project = await this.repo.get(id)
    if (project.status !== 'ready') throw new ConflictException('只有已发布的游戏可以局部改写。')
    if (!project.outline?.scenes.some((scene) => scene.id === sceneId)) throw new BadRequestException('场景不存在。')
    if (instruction.trim().length < 4 || instruction.length > 500) throw new BadRequestException('修改要求应为 4～500 个字。')
    if (/增加场景|删除场景|改变分支|新增结局|世界规则/.test(instruction)) {
      throw new BadRequestException('这项修改会改变大纲结构，需要重新规划，当前只支持单场景文字改写。')
    }
    if (project.mode === 'replay' && !/紧张|悬疑|压迫|对话|细节|更简洁/.test(instruction)) {
      throw new BadRequestException('Replay 只演示固定的文字改写；请使用 AI 模式提交自定义要求。')
    }
    await this.workspace.copyRevision(id, project.revision, project.revision + 1)
    await this.patch(id, { revision: project.revision + 1, status: 'writing_scenes', review: null, repairCount: 0 })
    await this.emit(id, 'scene_revision', `创建 Revision ${project.revision + 1}，只改写 ${sceneId}`, { instruction })
    setImmediate(() => void this.runDirect(id, async () => {
      const current = await this.repo.get(id)
      await this.writeScene(current, sceneId, instruction, false)
      await this.reviewAndRelease(id)
    }))
  }

  private async run(id: string, input: unknown): Promise<void> {
    await this.runDirect(id, async () => {
      const snapshot = await this.graph.getState(this.config(id))
      const nextInput = input === null && !snapshot.values?.projectId ? { projectId: id } : input
      await this.graph.invoke(nextInput, this.config(id))
    })
  }

  private async runDirect(id: string, work: () => Promise<unknown>): Promise<void> {
    if (this.running.has(id)) return
    const controller = new AbortController()
    this.running.set(id, controller)
    try { await work() }
    catch (error) {
      const project = await this.repo.get(id)
      if (project.status !== 'cancelled' && !this.shuttingDown) {
        const message = error instanceof Error ? error.message : String(error)
        await this.patch(id, { status: 'failed', failure: message, activeRole: null, currentTask: null })
        await this.emit(id, 'failed', message)
      }
    } finally { this.running.delete(id) }
  }

  private signal(id: string): AbortSignal { return this.running.get(id)?.signal ?? new AbortController().signal }

  private async ensureActive(id: string): Promise<void> {
    if ((await this.repo.get(id)).status === 'cancelled' || this.signal(id).aborted) throw new Error('任务已取消。')
  }

  private async patch(id: string, patch: Partial<Project>): Promise<Project> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const project = await this.repo.get(id)
      try { return await this.repo.save({ ...project, ...patch }) }
      catch (error) { if (!(error instanceof ConflictException) || attempt === 2) throw error }
    }
    throw new ConflictException('项目状态更新冲突。')
  }

  private async emit(id: string, kind: string, message: string, detail: Record<string, unknown> = {}): Promise<void> {
    await this.repo.event(id, kind, message, detail)
  }

  private async assignment(project: Project, role: Role, goal: string, reads: string[], names: string[], criteria: string[], extras: Partial<Assignment> = {}): Promise<Assignment> {
    const taskId = randomUUID()
    const writeFiles = await this.workspace.stage(project.id, taskId, names)
    const inputManifest: Record<string, string> = {}
    for (const path of reads) inputManifest[path] = hash(await this.workspace.readText(project.id, path))
    return {
      taskId, projectId: project.id, revision: project.revision, assignee: role,
      goal, readFiles: reads, writeFiles, skillPath: `/skills/${({
        'world-designer': 'world-building', 'plot-architect': 'branch-story-design',
        'scene-writer': 'scene-writing', 'continuity-reviewer': 'continuity-review'
      } as Record<Role, string>)[role]}/SKILL.md`, acceptanceCriteria: criteria, inputManifest, ...extras
    }
  }

  private async task<T>(project: Project, assignment: Assignment, destinations: string[], validate: (values: unknown[]) => T): Promise<T> {
    await this.ensureActive(project.id)
    const task = { id: assignment.taskId, role: assignment.assignee, status: 'running' as const, inputs: assignment.readFiles, outputs: destinations }
    const latest = await this.repo.get(project.id)
    await this.patch(project.id, { activeRole: assignment.assignee, currentTask: task.id, tasks: [...latest.tasks, task] })
    await this.emit(project.id, 'task_started', `${assignment.assignee} 开始任务`, { taskId: task.id, readFiles: task.inputs, writeFiles: task.outputs })
    try {
      await this.agents.execute(project, assignment, (kind, message, detail) => this.emit(project.id, kind, message, detail), this.signal(project.id))
      await this.ensureActive(project.id)
      const values = await Promise.all(assignment.writeFiles.map((path) => this.workspace.readJson(project.id, path)))
      const result = validate(values)
      for (const [path, previousHash] of Object.entries(assignment.inputManifest)) {
        if (hash(await this.workspace.readText(project.id, path)) !== previousHash) throw new Error(`任务输入已变化：${path}`)
      }
      await this.ensureActive(project.id)
      for (let i = 0; i < destinations.length; i++) {
        await this.workspace.promote(project.id, assignment.writeFiles[i], destinations[i])
      }
      const current = await this.repo.get(project.id)
      await this.patch(project.id, { activeRole: null, currentTask: null, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: 'completed' } : item) })
      await this.emit(project.id, 'task_completed', `${assignment.assignee} 的文件通过验收`, { taskId: task.id, destinations })
      return result
    } catch (error) {
      const current = await this.repo.get(project.id)
      await this.patch(project.id, { activeRole: null, currentTask: null, tasks: current.tasks.map((item) => item.id === task.id ? { ...item, status: 'failed', error: String(error) } : item) })
      throw error
    }
  }

  private async prepareWorld(id: string): Promise<void> {
    const project = await this.repo.get(id)
    if (project.world && project.characters) return
    await this.patch(id, { status: 'designing_world' })
    const base = `/revisions/${project.revision}`
    const assignment = await this.assignment(project, 'world-designer', '设计世界规则与人物档案', [`${base}/brief.md`, `${base}/brief.json`, '/contracts/world.schema.json', '/contracts/characters.schema.json'], ['world.json', 'characters.json'], ['符合世界规则', '角色数量与制作要求一致'])
    const [world, characters] = await this.task(project, assignment, [`${base}/world.json`, `${base}/characters.json`], ([rawWorld, rawCharacters]) => [WorldSchema.parse(rawWorld), CharactersSchema.parse(rawCharacters)] as const)
    if (characters.characters.length !== project.brief.characterCount) throw new Error('角色数量不符合制作要求。')
    await this.patch(id, { world, characters })
  }

  private async prepareOutline(id: string, feedback: string): Promise<void> {
    const project = await this.repo.get(id)
    if (project.outline && project.status === 'awaiting_outline_review') return
    await this.patch(id, { status: 'designing_outline' })
    const base = `/revisions/${project.revision}`
    const assignment = await this.assignment(project, 'plot-architect', `根据世界设定设计分支大纲。${feedback ? `用户修改意见：${feedback}` : ''}`, [`${base}/brief.md`, `${base}/world.json`, `${base}/characters.json`, '/contracts/outline.schema.json'], ['outline.json'], ['所有场景、结局和状态路径可达', '角色与场景数量符合要求'])
    const outline = await this.task(project, assignment, [`${base}/outline-v${project.outlineVersion}.json`], ([raw]) => {
      const value = OutlineSchema.parse(raw)
      assertOutline(project.brief, value, project.characters!)
      return value
    })
    await this.patch(id, { outline, status: 'awaiting_outline_review' })
    await this.emit(id, 'outline_ready', `Outline v${project.outlineVersion} 等待人工审核`)
  }

  private async prepareScenes(id: string): Promise<void> {
    const project = await this.repo.get(id)
    if (!project.outline || project.approvedOutlineVersion !== project.outlineVersion) throw new Error('当前大纲尚未批准。')
    await this.patch(id, { status: 'writing_scenes' })
    for (const scene of project.outline.scenes) {
      await this.ensureActive(id)
      const path = `/revisions/${project.revision}/scenes/${scene.id}.json`
      try { assertScene(project.outline, await this.workspace.readJson(id, path), scene.id); continue }
      catch { await this.writeScene(project, scene.id, undefined, false) }
    }
  }

  private async writeScene(project: Project, sceneId: string, instruction?: string, repair = false): Promise<void> {
    if (!project.outline) throw new Error('没有已批准大纲。')
    const base = `/revisions/${project.revision}`
    const reads = [`${base}/brief.md`, `${base}/world.json`, `${base}/characters.json`, `${base}/outline-v${project.outlineVersion}.json`, '/contracts/scene.schema.json']
    if (repair || instruction) reads.push(`${base}/scenes/${sceneId}.json`)
    if (repair) reads.push(`${base}/reviews/review-${project.repairCount - 1}.json`)
    const goal = repair ? `根据审核问题修复 ${sceneId} 的正文，不修改任何其他场景。` : instruction ? `按用户要求改写 ${sceneId}：${instruction}` : `按照已批准大纲编写 ${sceneId} 的正文。`
    const assignment = await this.assignment(project, 'scene-writer', goal, reads, [`${sceneId}.json`], ['只写本场景标题与正文', '分支结构与批准大纲完全一致'], { sceneId, instruction })
    await this.task(project, assignment, [`${base}/scenes/${sceneId}.json`], ([raw]) => assertScene(project.outline!, raw, sceneId))
  }

  private async scenes(project: Project): Promise<Scene[]> {
    if (!project.outline) throw new Error('大纲缺失。')
    const values: Scene[] = []
    for (const item of project.outline.scenes) values.push(assertScene(project.outline, await this.workspace.readJson(project.id, `/revisions/${project.revision}/scenes/${item.id}.json`), item.id))
    return values
  }

  private async reviewAndRelease(id: string): Promise<void> {
    let project = await this.repo.get(id)
    if (!project.outline || !project.characters || !project.approvedOutlineVersion) throw new Error('构建依赖尚未齐全。')
    while (true) {
      await this.ensureActive(id)
      await this.patch(id, { status: 'reviewing' })
      project = await this.repo.get(id)
      const scenes = await this.scenes(project)
      const base = `/revisions/${project.revision}`
      const paths = project.outline!.scenes.map((item) => `${base}/scenes/${item.id}.json`)
      const assignment = await this.assignment(project, 'continuity-reviewer', '检查全部场景是否违反世界设定或人物动机，给出有原文依据的审核报告', [`${base}/brief.md`, `${base}/world.json`, `${base}/characters.json`, `${base}/outline-v${project.outlineVersion}.json`, ...paths, '/contracts/review.schema.json'], ['review.json'], ['问题引用必须来自真实场景正文', '无问题时 approved 且 issues 为空'])
      const report = await this.task(project, assignment, [`${base}/reviews/review-${project.repairCount}.json`], ([raw]) => assertReview(raw, scenes))
      await this.patch(id, { review: report })
      await this.emit(id, 'review_completed', report.verdict === 'approved' ? '剧情一致性审核通过' : `发现 ${report.issues.length} 个剧情问题`, { issues: report.issues })
      if (report.verdict === 'approved') break
      if (project.repairCount >= 2) {
        await this.patch(id, { status: 'needs_human_review', failure: '自动返工已达到两轮，请人工检查。' })
        return
      }
      const affected = [...new Set(report.issues.map((issue) => issue.filePath.replace('/scenes/', '').replace('.json', '')))]
      await this.patch(id, { repairCount: project.repairCount + 1 })
      project = await this.repo.get(id)
      for (const sceneId of affected) await this.writeScene(project, sceneId, undefined, true)
      await this.emit(id, 'repair_completed', `只返工 ${affected.join('、')}`, { affected })
    }
    await this.ensureActive(id)
    project = await this.repo.get(id)
    const finished = await this.scenes(project)
    const sourcePaths = [`/revisions/${project.revision}/world.json`, `/revisions/${project.revision}/characters.json`, `/revisions/${project.revision}/outline-v${project.outlineVersion}.json`, ...project.outline!.scenes.map((scene) => `/revisions/${project.revision}/scenes/${scene.id}.json`)]
    const release = await this.builder.release(project, gameFromOutline(project.brief, project.outline!, project.characters!, finished), sourcePaths)
    await this.ensureActive(id)
    await this.patch(id, { latestReleaseId: release.id, releaseIds: [...project.releaseIds, release.id], status: 'ready', failure: null, activeRole: null })
    await this.emit(id, 'released', '游戏已通过检查，可以试玩与下载', { releaseId: release.id, endings: Object.keys(release.paths) })
  }
}
