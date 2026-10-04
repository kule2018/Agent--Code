import 'reflect-metadata'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, type BaseMessage } from '@langchain/core/messages'
import { ChatDeepSeek } from '@langchain/deepseek'
import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph'
import { AgentExecutionService, type Assignment } from './agents.js'
import { WorkspaceService } from './workspace.js'
import { StoryService } from './story.service.js'
import { replayBrief } from './replay.js'
import type { Project } from './project.js'

test('角色任务失败后恢复外层 Graph：跳过成功场景，为失败场景重新委派并写入新路径', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'story-agent-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = new WorkspaceService()
  t.mock.method(workspace, 'projectRoot', (id: string) => join(root, id))
  const previousKey = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'offline-test-key'
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
  })

  const project = { id: randomUUID(), mode: 'ai' } as Project
  await workspace.prepare(project.id, 1, { ...replayBrief, mode: 'ai' })
  let shouldFail = true
  // 只替换模型响应，实际运行 Deep Agents 的委派、文件工具和 LangGraph 恢复。
  t.mock.method(ChatDeepSeek.prototype, '_generate', async (messages: BaseMessage[]) => {
    const assignment = JSON.parse(String(messages.findLast((message) => message.type === 'human')!.content)) as Assignment
    const isDirector = messages.some((message) => message.type === 'system' && JSON.stringify(message.content).includes('你是剧情总导演'))
    const results = messages.filter((message) => message.type === 'tool')
    const call = (name: string, args: Record<string, unknown>) => new AIMessage({
      content: '', tool_calls: [{ id: randomUUID(), name, args, type: 'tool_call' }]
    })
    let message: AIMessage
    if (isDirector) {
      message = results.length ? new AIMessage('角色已完成交付。') : call('task', {
        subagent_type: assignment.assignee, description: JSON.stringify(assignment)
      })
    } else if (!results.length) {
      message = call('read_file', { file_path: assignment.skillPath })
    } else if (assignment.sceneId === 'scene-2' && shouldFail) {
      shouldFail = false
      throw new Error('模拟角色读取 Skill 后模型请求超时')
    } else if (results.length === 1) {
      message = call('write_file', {
        file_path: assignment.writeFiles[0], content: JSON.stringify({ id: assignment.sceneId })
      })
    } else {
      message = new AIMessage(assignment.writeFiles[0])
    }
    return { generations: [{ text: String(message.content), message }] }
  })

  const service = new AgentExecutionService(workspace)
  const completed = new Set<string>()
  const attempts: Assignment[] = []
  const delegated: string[] = []
  const State = Annotation.Root({ projectId: Annotation<string>() })
  const graph = new StateGraph(State)
    .addNode('scenes', async () => {
      for (const sceneId of ['scene-1', 'scene-2']) {
        if (completed.has(sceneId)) continue
        const taskId = randomUUID()
        const assignment: Assignment = {
          taskId, projectId: project.id, revision: 1, assignee: 'scene-writer',
          goal: `编写 ${sceneId}`, sceneId, readFiles: [],
          writeFiles: await workspace.stage(project.id, taskId, [`${sceneId}.json`]),
          skillPath: '/skills/scene-writing/SKILL.md', acceptanceCriteria: [], inputManifest: {}
        }
        attempts.push(assignment)
        await service.execute(project, assignment, async (kind) => {
          if (kind === 'ai_delegate') delegated.push(taskId)
        }, new AbortController().signal)
        assert.deepEqual(await workspace.readJson(project.id, assignment.writeFiles[0]), { id: sceneId })
        completed.add(sceneId)
      }
      return {}
    })
    .addEdge(START, 'scenes')
    .addEdge('scenes', END)
    .compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: project.id } }

  await assert.rejects(graph.invoke({ projectId: project.id }, config), /模拟角色读取 Skill 后模型请求超时/)
  assert.deepEqual([...completed], ['scene-1'])
  await graph.invoke(null, config)
  assert.deepEqual([...completed], ['scene-1', 'scene-2'])
  assert.deepEqual(attempts.map((item) => item.sceneId), ['scene-1', 'scene-2', 'scene-2'])
  assert.notEqual(attempts[1].writeFiles[0], attempts[2].writeFiles[0])
  assert.deepEqual(delegated, attempts.map((item) => item.taskId))
  assert.deepEqual((await graph.getState(config)).next, [])
})

test('请求失败后的重试保留审核返工轮数，避免覆盖旧审核报告', async () => {
  const updates: Partial<Project>[] = []
  const fake = {
    repo: { get: async () => ({ status: 'failed', outline: {}, repairCount: 1 }) },
    patch: async (_id: string, value: Partial<Project>) => { updates.push(value) },
    run: async () => {},
    runDirect: async () => {}
  }
  await StoryService.prototype.retry.call(fake as unknown as StoryService, 'test-project')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(updates[0].repairCount, 1)
})
