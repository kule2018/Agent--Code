import { Inject, Injectable } from '@nestjs/common'
import { ChatDeepSeek } from '@langchain/deepseek'
import { createDeepAgent, FilesystemBackend } from 'deepagents'
import { createMiddleware } from 'langchain'
import type { Project } from './project.js'
import { WorkspaceService } from './workspace.js'
import { defectQuote, replayCharacters, replayOutline, replayReport, replayRevisedOutline, replayRevisedScene, replayScenes, replayWorld } from './replay.js'

export type Role = 'world-designer' | 'plot-architect' | 'scene-writer' | 'continuity-reviewer'
export type Assignment = {
  taskId: string
  projectId: string
  revision: number
  assignee: Role
  goal: string
  readFiles: string[]
  writeFiles: string[]
  skillPath: string
  acceptanceCriteria: string[]
  inputManifest: Record<string, string>
  sceneId?: string
  instruction?: string
}
export type AgentEvent = (kind: string, message: string, detail?: Record<string, unknown>) => Promise<void>

const roleProfiles: Record<Role, { description: string; systemPrompt: string }> = {
  'world-designer': {
    description: '根据制作要求设计世界规则和人物档案，并保存两个 JSON 文件。',
    systemPrompt: '你是世界观设计师。先读取任务单中的 Skill、brief 和交付 Schema。遵守用户明确提出的世界规则，生成世界观和指定数量的人物。把完整 JSON 写入各自路径，再读取核对。只返回路径与简短摘要。'
  },
  'plot-architect': {
    description: '根据世界规则和人物设计可玩的有限分支剧情大纲。',
    systemPrompt: '你是剧情策划。先读取 Skill、brief、世界规则、人物和 outline Schema。按照 brief 规定的场景总数与结局数设计剧情，两个布尔状态以内优先。所有选项可达且至少一处因前面选择改变后续可选项。每个普通场景提供两个选择，结局没有选择。仅交付 JSON 文件路径和简短说明。'
  },
  'scene-writer': {
    description: '按照已批准的大纲只编写当前场景的标题和正文。',
    systemPrompt: '你是场景编剧。先读取 Skill、世界观、大纲、角色和相邻场景摘要。只编写任务指定场景，保留大纲给出的 id、ending 与 choices，不更改分支、条件或效果。若是返工，根据报告修复明确问题，保留选项原有收益与代价。写入 JSON 后重新读取，最后只汇报路径与摘要。'
  },
  'continuity-reviewer': {
    description: '对照世界规则、人物和剧情大纲，输出带真实原文引用的审核报告。',
    systemPrompt: '你是剧情一致性审核者。先读取 Skill、世界观、人物、大纲、场景和 review Schema。只报告明确的世界规则、人物或时间线冲突，不猜测未提供的设定，也不因个人审美要求返工。同一根本问题只报告一次。quote 必须逐字摘录受影响场景 content 中的原文；建议不得违反其他规则。只写任务指定的审核报告，不修改场景。'
  }
}

/** 两种模式共用任务单和候选文件；Replay 明确记录预设结果。 */
@Injectable()
export class AgentExecutionService {
  constructor(@Inject(WorkspaceService) private readonly workspace: WorkspaceService) {}

  async execute(project: Project, assignment: Assignment, event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (project.mode === 'replay') {
      await this.runReplay(project, assignment, event)
      return
    }
    await this.runAI(project, assignment, event, signal)
  }

  private async runReplay(project: Project, assignment: Assignment, event: AgentEvent): Promise<void> {
    await event('replay_delegate', `预设演示：总导演委派 ${assignment.assignee}`, { taskId: assignment.taskId })
    const [first, second] = assignment.writeFiles
    switch (assignment.assignee) {
      case 'world-designer':
        await this.workspace.writeJson(project.id, first, replayWorld)
        await this.workspace.writeJson(project.id, second, replayCharacters)
        break
      case 'plot-architect':
        await this.workspace.writeJson(project.id, first, project.outlineVersion > 1 ? replayRevisedOutline(assignment.goal) : replayOutline)
        break
      case 'scene-writer': {
        const scene = assignment.instruction
          ? replayRevisedScene(assignment.sceneId!, assignment.instruction)
          : assignment.goal.includes('审核问题')
            ? replayRevisedScene(assignment.sceneId!)
            : replayScenes(project.brief.replayScenario === 'defect').find((item) => item.id === assignment.sceneId)
        if (!scene) throw new Error(`Replay 缺少场景：${assignment.sceneId}`)
        await this.workspace.writeJson(project.id, first, scene)
        break
      }
      case 'continuity-reviewer': {
        const content = await this.workspace.readText(project.id, `/revisions/${project.revision}/scenes/ending-02.json`)
        const report = replayReport(content.includes(defectQuote))
        await this.workspace.writeJson(project.id, first, report)
        break
      }
    }
    await event('replay_artifact', '预设角色产物已写入候选目录', { paths: assignment.writeFiles })
  }

  private async runAI(project: Project, assignment: Assignment, event: AgentEvent, signal: AbortSignal): Promise<void> {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('AI 模式需要在本机配置 DEEPSEEK_API_KEY。')
    const profile = roleProfiles[assignment.assignee]
    const model = new ChatDeepSeek({
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
      temperature: 0, maxRetries: 1, timeout: 120_000
    })
    let dispatched = false
    let skillRead = false
    const backend = new FilesystemBackend({ rootDir: this.workspace.projectRoot(project.id), virtualMode: true })
    const child = {
      name: assignment.assignee,
      ...profile,
      mode: 'isolated' as const,
      skills: ['/skills/'],
      permissions: [
        { operations: ['write'] as const, paths: assignment.writeFiles, mode: 'allow' as const },
        { operations: ['write'] as const, paths: ['/**'], mode: 'deny' as const }
      ],
      middleware: [createMiddleware({
        name: 'StoryWorkerTrace',
        wrapToolCall: async (request, handler) => {
          const call = request.toolCall
          const allowed = ['read_file', 'write_file', 'edit_file', 'ls', 'glob', 'grep', 'search']
          if (!allowed.includes(call.name)) throw new Error(`角色不能执行 ${call.name}。`)
          const filePath = String(call.args.file_path ?? call.args.path ?? '')
          if (call.name === 'read_file' && filePath === assignment.skillPath) skillRead = true
          await event('ai_tool', `${assignment.assignee} 调用 ${call.name}`, { taskId: assignment.taskId, filePath })
          return handler(request)
        }
      })]
    }
    const director = await createDeepAgent({
      name: 'story-director', model, backend,
      permissions: [{ operations: ['write'], paths: ['/**'], mode: 'deny' }],
      subagents: [child],
      systemPrompt: `你是剧情总导演。当前阶段已经确定任务单和角色。
请调用一次 task，把完整 JSON 任务单委派给 assignee。等待该角色完成后只回复交付路径与简短摘要。
你不直接写文件，也不调用其他工具。`,
      middleware: [createMiddleware({
        name: 'StoryDelegationBoundary',
        wrapToolCall: async (request, handler) => {
          const call = request.toolCall
          if (call.name !== 'task' || call.args.subagent_type !== assignment.assignee || dispatched) {
            throw new Error('本阶段只允许向指定角色委派一次任务。')
          }
          dispatched = true
          await event('ai_delegate', `总导演调用 task 委派 ${assignment.assignee}`, { taskId: assignment.taskId })
          return handler({
            ...request,
            toolCall: { ...call, args: { ...call.args, description: JSON.stringify(assignment) } }
          })
        }
      })]
    })
    await director.invoke(
      { messages: [{ role: 'user', content: JSON.stringify(assignment) }] },
      { recursionLimit: 45, signal }
    )
    if (!dispatched) throw new Error('总导演没有委派任务。')
    if (!skillRead) throw new Error(`${assignment.assignee} 没有读取指定 Skill。`)
    for (const filePath of assignment.writeFiles) await this.workspace.readText(project.id, filePath)
  }
}
