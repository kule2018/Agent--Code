<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { VueFlow, MarkerType, type Edge, type Node } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import {
  Activity, ArrowLeft, BookOpen, Check, ChevronRight, CircleHelp, Download,
  FileCode2, Film, FolderOpen, GitBranch, Menu, MoreHorizontal, Pause,
  Play, Plus, RotateCcw, ShieldCheck, Sparkles, X
} from '@lucide/vue'
import { availableChoices, choose, currentScene, startGame, type Game, type Session } from '../../shared/engine'

type Brief = {
  title: string; premise: string; genre: string; audience: string; worldRules: string
  characterCount: number; sceneCount: number; endingCount: number
  mode: 'replay' | 'ai'; replayScenario: 'normal' | 'defect'
}
type ScenePlan = { id: string; summary: string; ending: boolean; choices: { id: string; text: string; to: string; when: Record<string, boolean> }[] }
type Project = {
  id: string; status: string; mode: 'replay' | 'ai'; brief: Brief; revision: number
  outlineVersion: number; approvedOutlineVersion: number | null
  outline: { scenes: ScenePlan[]; startSceneId: string; title: string } | null
  world: { summary: string; rules: string[] } | null
  characters: { characters: { id: string; name: string; goal: string; motivation: string }[] } | null
  review: { verdict: string; issues: { filePath: string; quote: string; reason: string; suggestion: string }[] } | null
  tasks: { id: string; role: string; status: string; inputs: string[]; outputs: string[] }[]
  releaseIds: string[]; latestReleaseId: string | null; activeRole: string | null
  failure: string | null; repairCount: number; createdAt: string
}
type StoryEvent = { id: number; kind: string; message: string; detail: Record<string, unknown>; createdAt: string }

const preset: Brief = {
  title: '失联太空站',
  premise: '太空站与地球失去联系。最后的电池只能支撑一个主要系统，工程师林澜必须在有限时间内决定如何让大家活下去。',
  genre: '科幻悬疑', audience: '喜欢选择与悬疑故事的玩家',
  worldRules: '太空站无法恢复对外通信，也无法获得外部救援。剩余电量只能支持一个高耗能系统。',
  characterCount: 3, sceneCount: 8, endingCount: 3, mode: 'replay', replayScenario: 'normal'
}
const projects = ref<Project[]>([])
const selectedId = ref<string | null>(null)
const project = ref<Project | null>(null)
const events = ref<StoryEvent[]>([])
const files = ref<string[]>([])
const filePath = ref('')
const fileContent = ref('')
const game = ref<Game | null>(null)
const loadedReleaseId = ref<string | null>(null)
const session = ref<Session | null>(null)
const activeTab = ref<'overview' | 'outline' | 'files' | 'play'>('overview')
const mobilePane = ref<'projects' | 'content' | 'activity'>('content')
const showCreate = ref(false)
const draft = ref<Brief>({ ...preset })
const feedback = ref('')
const reviseSceneId = ref('')
const reviseInstruction = ref('')
const busy = ref(false)
const error = ref('')
const aiConfigured = ref(false)

const statusNames: Record<string, string> = {
  queued: '等待启动', designing_world: '设计世界观', designing_outline: '设计剧情大纲',
  awaiting_outline_review: '等待大纲审核', writing_scenes: '编写场景', reviewing: '剧情审核',
  needs_human_review: '需要人工处理', ready: '可以试玩', failed: '运行失败', cancelled: '已停止'
}
const roleNames: Record<string, string> = {
  'world-designer': '世界观设计师', 'plot-architect': '剧情策划',
  'scene-writer': '场景编剧', 'continuity-reviewer': '一致性审核者'
}
const isActive = computed(() => Boolean(project.value && !['ready', 'failed', 'cancelled', 'awaiting_outline_review', 'needs_human_review'].includes(project.value.status)))
const scene = computed(() => game.value && session.value ? currentScene(game.value, session.value) : null)
const choices = computed(() => scene.value && session.value ? availableChoices(scene.value, session.value.flags) : [])
const graphNodes = computed<Node[]>(() => {
  const plans = project.value?.outline?.scenes ?? []
  const levels = new Map<string, number>()
  const start = project.value?.outline?.startSceneId
  if (start) levels.set(start, 0)
  for (let round = 0; round < plans.length; round++) for (const item of plans) {
    const level = levels.get(item.id)
    if (level === undefined) continue
    for (const choice of item.choices) levels.set(choice.to, Math.max(levels.get(choice.to) ?? 0, level + 1))
  }
  const columns = new Map<number, number>()
  return plans.map((item) => {
    const column = Math.min(levels.get(item.id) ?? 0, 3)
    const row = columns.get(column) ?? 0
    columns.set(column, row + 1)
    return {
      id: item.id, position: { x: 24 + column * 225, y: 30 + row * 102 },
      data: { label: `${item.ending ? '结局' : '场景'} · ${item.id}` },
      class: item.ending ? 'ending-node' : 'scene-node'
    }
  })
})
const graphEdges = computed<Edge[]>(() => (project.value?.outline?.scenes ?? []).flatMap((item) =>
  item.choices.map((choice) => ({ id: `${item.id}-${choice.id}`, source: item.id, target: choice.to,
    label: choice.when && Object.keys(choice.when).length ? '条件' : undefined,
    markerEnd: MarkerType.ArrowClosed, animated: false }))))

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projects${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) } })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(Array.isArray(value.message) ? value.message.join('；') : value.message ?? `请求失败：${response.status}`)
  return value as T
}
async function refresh(): Promise<void> {
  try {
    projects.value = await request<Project[]>('')
    if (!selectedId.value && projects.value.length) selectedId.value = projects.value[0].id
    if (!selectedId.value) return
    const id = selectedId.value
    project.value = await request<Project>(`/${id}`)
    events.value = await request<StoryEvent[]>(`/${id}/events`)
    connectStream(id)
    files.value = await request<string[]>(`/${id}/files`)
    if (project.value.latestReleaseId && loadedReleaseId.value !== project.value.latestReleaseId) {
      game.value = await request<Game>(`/${id}/releases/${project.value.latestReleaseId}/game`)
      loadedReleaseId.value = project.value.latestReleaseId
      session.value = null
    }
  } catch (caught) { error.value = (caught as Error).message }
}
async function selectProject(id: string): Promise<void> {
  selectedId.value = id; project.value = null; filePath.value = ''; fileContent.value = ''
  game.value = null; loadedReleaseId.value = null; session.value = null; mobilePane.value = 'content'; activeTab.value = 'overview'
  await refresh()
}
function openCreate(): void { draft.value = { ...preset }; showCreate.value = true; error.value = '' }
function setMode(mode: 'replay' | 'ai'): void { draft.value = mode === 'replay' ? { ...preset } : { ...preset, mode: 'ai', title: '', premise: '', worldRules: '' } }
async function create(): Promise<void> {
  busy.value = true; error.value = ''
  try {
    const created = await request<Project>('', { method: 'POST', body: JSON.stringify(draft.value) })
    showCreate.value = false
    await selectProject(created.id)
  } catch (caught) { error.value = (caught as Error).message }
  finally { busy.value = false }
}
async function action(path: string, payload?: object): Promise<void> {
  if (!project.value) return
  busy.value = true; error.value = ''
  try {
    await request(`/${project.value.id}/${path}`, { method: 'POST', body: JSON.stringify(payload ?? {}) })
    await refresh()
  } catch (caught) { error.value = (caught as Error).message }
  finally { busy.value = false }
}
function review(decision: 'approve' | 'revise' | 'reject'): void {
  if (!project.value) return
  void action('outline-review', { decision, outlineVersion: project.value.outlineVersion, feedback: feedback.value })
}
async function openFile(path: string): Promise<void> {
  if (!project.value) return
  filePath.value = path; activeTab.value = 'files'; mobilePane.value = 'content'
  try { fileContent.value = (await request<{ content: string }>(`/${project.value.id}/file?path=${encodeURIComponent(path)}`)).content }
  catch (caught) { error.value = (caught as Error).message }
}
function startPlaying(): void { if (game.value) { session.value = startGame(game.value); activeTab.value = 'play'; mobilePane.value = 'content' } }
function pick(choiceId: string): void { if (game.value && session.value) session.value = choose(game.value, session.value, choiceId) }
function download(): void {
  if (!project.value?.latestReleaseId) return
  window.location.href = `/api/projects/${project.value.id}/releases/${project.value.latestReleaseId}/download`
}
let timer: ReturnType<typeof setInterval>
let stream: EventSource | null = null
let streamProjectId: string | null = null
function connectStream(id: string): void {
  if (streamProjectId === id) return
  stream?.close()
  streamProjectId = id
  stream = new EventSource(`/api/projects/${id}/events/live?after=${events.value.at(-1)?.id ?? 0}`)
  stream.onmessage = (message) => {
    if (selectedId.value !== id) return
    const event = JSON.parse(message.data) as StoryEvent
    if (!events.value.some((item) => item.id === event.id)) events.value = [...events.value, event]
    void refresh()
  }
}
onMounted(async () => {
  try { aiConfigured.value = (await request<{ aiConfigured: boolean }>('/meta')).aiConfigured } catch { /* API error appears on refresh */ }
  await refresh()
  timer = setInterval(() => void refresh(), 5000)
})
onUnmounted(() => { clearInterval(timer); stream?.close() })
watch(selectedId, (id) => {
  filePath.value = ''; fileContent.value = ''
  stream?.close()
  stream = null
  streamProjectId = null
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark"><Film :size="20" /></span><span>剧情工坊 <small>STORY STUDIO</small></span></div>
      <div class="topbar-meta"><span class="online-dot"></span> 本地制作工作台 <span class="top-divider"></span> {{ project?.mode === 'ai' ? 'AI 模式' : 'Replay 演示' }}</div>
      <button class="primary-button top-create" type="button" @click="openCreate"><Plus :size="17" /> 新建作品</button>
    </header>

    <div class="mobile-nav">
      <button :class="{ selected: mobilePane === 'projects' }" @click="mobilePane = 'projects'"><FolderOpen :size="18" />项目</button>
      <button :class="{ selected: mobilePane === 'content' }" @click="mobilePane = 'content'"><BookOpen :size="18" />内容</button>
      <button :class="{ selected: mobilePane === 'activity' }" @click="mobilePane = 'activity'"><Activity :size="18" />动态</button>
    </div>

    <main class="workspace-layout">
      <aside class="pane sidebar" :class="{ 'mobile-visible': mobilePane === 'projects' }">
        <div class="sidebar-section">
          <div class="section-head"><span>作品项目</span><button class="icon-button" title="新建作品" @click="openCreate"><Plus :size="17" /></button></div>
          <button v-for="item in projects" :key="item.id" class="project-item" :class="{ selected: item.id === selectedId }" @click="selectProject(item.id)">
            <span class="project-glyph"><Film :size="16" /></span>
            <span class="project-copy"><strong>{{ item.brief.title }}</strong><small>{{ statusNames[item.status] ?? item.status }} · {{ item.mode === 'ai' ? 'AI' : 'Replay' }}</small></span>
            <ChevronRight :size="15" />
          </button>
          <button v-if="!projects.length" class="empty-action" @click="openCreate"><Plus :size="16" />创建第一部作品</button>
        </div>
        <div v-if="project" class="sidebar-section file-section">
          <div class="section-head"><span>项目文件</span><span class="count">{{ files.length }}</span></div>
          <button v-for="path in files" :key="path" class="file-item" :class="{ selected: path === filePath }" :title="path" @click="openFile(path)"><FileCode2 :size="15" /><span>{{ path.split('/').at(-1) }}</span></button>
          <p v-if="!files.length" class="muted-note">文件将在制作过程中出现。</p>
        </div>
        <div class="sidebar-bottom"><ShieldCheck :size="16" /><span>每个作品都在独立 Workspace 中制作</span></div>
      </aside>

      <section class="pane main-pane" :class="{ 'mobile-visible': mobilePane === 'content' }">
        <template v-if="project">
          <div class="project-heading">
            <div><div class="eyebrow">PROJECT / {{ project.id.slice(0, 8).toUpperCase() }}</div><h1>{{ project.brief.title }}</h1><p>{{ project.brief.premise }}</p></div>
            <span class="status-pill" :class="project.status"><span class="status-dot"></span>{{ statusNames[project.status] ?? project.status }}</span>
          </div>
          <div class="tabs">
            <button :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'"><Activity :size="16" />概览</button>
            <button :class="{ active: activeTab === 'outline' }" @click="activeTab = 'outline'"><GitBranch :size="16" />剧情分支</button>
            <button :class="{ active: activeTab === 'files' }" @click="activeTab = 'files'"><FolderOpen :size="16" />文件</button>
            <button :class="{ active: activeTab === 'play' }" :disabled="!project.latestReleaseId" @click="startPlaying"><Play :size="16" />试玩</button>
          </div>
          <div class="content-scroll">
            <template v-if="activeTab === 'overview'">
              <div class="metrics">
                <div><span>当前版本</span><strong>Revision {{ project.revision }}</strong></div>
                <div><span>场景任务</span><strong>{{ project.outline?.scenes.length ?? project.brief.sceneCount }} <small>场景</small></strong></div>
                <div><span>交付状态</span><strong>{{ project.latestReleaseId ? '已发布' : '制作中' }}</strong></div>
              </div>
              <section class="content-section">
                <div class="content-heading"><h2>制作进度</h2><span>{{ project.tasks.filter(t => t.status === 'completed').length }} / {{ project.tasks.length }} 项任务完成</span></div>
                <div class="pipeline">
                  <div v-for="(step, index) in ['世界与人物', '分支大纲', '大纲审核', '场景编写', '一致性审核', '游戏构建']" :key="step" class="pipeline-step" :class="{ done: index === 0 ? !!project.world : index === 1 ? !!project.outline : index === 2 ? !!project.approvedOutlineVersion : index === 3 ? project.tasks.filter(t => t.role === 'scene-writer' && t.status === 'completed').length >= project.brief.sceneCount : index === 4 ? project.review?.verdict === 'approved' : !!project.latestReleaseId }"><span class="step-icon"><Check v-if="index === 0 ? !!project.world : index === 1 ? !!project.outline : index === 2 ? !!project.approvedOutlineVersion : index === 3 ? project.tasks.filter(t => t.role === 'scene-writer' && t.status === 'completed').length >= project.brief.sceneCount : index === 4 ? project.review?.verdict === 'approved' : !!project.latestReleaseId" :size="14" />{{ index + 1 }}</span><span>{{ step }}</span></div>
                </div>
              </section>
              <section v-if="project.status === 'awaiting_outline_review'" class="content-section review-panel">
                <div class="content-heading"><h2>请审核 Outline v{{ project.outlineVersion }}</h2><span>人工审核</span></div>
                <p>剧情策划已交付大纲。查看分支和场景摘要后，决定批准、修改或拒绝。</p>
                <button class="text-action" @click="activeTab = 'outline'">查看剧情分支 <ChevronRight :size="15" /></button>
                <textarea v-model="feedback" rows="2" placeholder="修改意见，例如：让结局的代价更明确" aria-label="大纲修改意见"></textarea>
                <div class="button-row"><button class="primary-button" :disabled="busy" @click="review('approve')"><Check :size="16" />批准大纲</button><button class="secondary-button" :disabled="busy || !feedback.trim()" @click="review('revise')">要求修改</button><button class="subtle-button" :disabled="busy" @click="review('reject')">拒绝并停止</button></div>
              </section>
              <section v-if="project.review?.issues.length" class="content-section"><div class="content-heading"><h2>审核发现的问题</h2><span>{{ project.review.issues.length }} 条</span></div><div v-for="issue in project.review.issues" :key="issue.filePath" class="issue"><strong>{{ issue.filePath }}</strong><blockquote>{{ issue.quote }}</blockquote><p>{{ issue.reason }}</p><small>{{ issue.suggestion }}</small></div></section>
              <section v-if="project.latestReleaseId" class="content-section release-panel"><div><div class="eyebrow">PLAYABLE RELEASE</div><h2>你的互动剧情已经可以游玩</h2><p>选择会改变后续场景；每个结局都已通过可达性检查。</p></div><div class="button-row"><button class="primary-button" @click="startPlaying"><Play :size="16" />开始试玩</button><button class="secondary-button" @click="download"><Download :size="16" />下载离线游戏</button></div></section>
              <section v-if="project.status === 'ready'" class="content-section"><div class="content-heading"><h2>局部改写场景</h2><span>生成新版本，保留旧 Release</span></div><div class="revision-controls"><select v-model="reviseSceneId" aria-label="选择场景"><option value="">选择场景</option><option v-for="item in project.outline?.scenes" :key="item.id" :value="item.id">{{ item.id }} · {{ item.summary.slice(0, 18) }}…</option></select><input v-model="reviseInstruction" placeholder="例如：让这里的气氛更紧张" aria-label="场景修改要求"><button class="secondary-button" :disabled="busy || !reviseSceneId || reviseInstruction.length < 4" @click="action('revise-scene', { sceneId: reviseSceneId, instruction: reviseInstruction })">提交改写</button></div></section>
              <section v-if="project.failure" class="content-section failure"><h2>{{ project.status === 'needs_human_review' ? '需要人工处理' : '执行失败' }}</h2><p>{{ project.failure }}</p><button class="secondary-button" :disabled="busy" @click="action('retry')"><RotateCcw :size="16" />重试当前任务</button></section>
              <div v-if="isActive" class="quiet-progress"><span class="spinner"></span>{{ project.activeRole ? `${roleNames[project.activeRole] ?? project.activeRole} 正在工作` : statusNames[project.status] }}</div>
            </template>

            <template v-else-if="activeTab === 'outline'">
              <div v-if="project.outline" class="outline-view"><div class="content-heading"><div><div class="eyebrow">OUTLINE V{{ project.outlineVersion }}</div><h2>{{ project.outline.title }}</h2></div><span>{{ project.outline.scenes.length }} 场景 / {{ project.outline.scenes.filter(s => s.ending).length }} 结局</span></div><div class="graph-frame"><VueFlow :nodes="graphNodes" :edges="graphEdges" fit-view-on-init :min-zoom="0.35" :max-zoom="1.4" :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="true" /></div><div class="scene-list"><button v-for="item in project.outline.scenes" :key="item.id" class="scene-summary" @click="openFile(`/revisions/${project!.revision}/scenes/${item.id}.json`)"><span>{{ item.id }}</span><strong>{{ item.summary }}</strong><small>{{ item.ending ? '结局' : `${item.choices.length} 个选项` }}</small></button></div></div>
              <div v-else class="blank-state"><GitBranch :size="34" /><h2>剧情分支尚未交付</h2><p>剧情策划会先完成大纲，再由你决定是否批准。</p></div>
            </template>

            <template v-else-if="activeTab === 'files'"><div class="content-heading"><div><div class="eyebrow">WORKSPACE / REVISION {{ project.revision }}</div><h2>{{ filePath ? filePath.split('/').at(-1) : '真实项目文件' }}</h2></div><span>{{ files.length }} 个文件</span></div><p v-if="filePath" class="file-path">{{ filePath }}</p><pre v-if="fileContent" class="file-code">{{ fileContent }}</pre><div v-else class="blank-state"><FileCode2 :size="34" /><h2>选择一个文件查看</h2><p>左侧文件来自当前项目的 Workspace。</p></div></template>

            <template v-else-if="activeTab === 'play'"><div v-if="game && scene && session" class="game-stage"><div class="game-shade"></div><div class="game-story"><div class="eyebrow">{{ scene.ending ? 'THE END' : 'INTERACTIVE STORY' }} / {{ scene.id }}</div><h2>{{ scene.title }}</h2><p>{{ scene.content }}</p><div class="choice-list"><button v-for="choice in choices" :key="choice.id" @click="pick(choice.id)"><span>{{ choice.text }}</span><ChevronRight :size="17" /></button><button v-if="scene.ending" @click="session = startGame(game)"><RotateCcw :size="16" />重新开始</button></div><div class="game-footer"><span>{{ session.history.length }} 次选择</span><span>{{ Object.values(session.flags).filter(Boolean).length }} 项状态已改变</span><button title="重新开始" @click="session = startGame(game)"><RotateCcw :size="15" /></button></div></div></div><div v-else class="blank-state"><Play :size="34" /><h2>游戏尚未发布</h2></div></template>
          </div>
        </template>
        <div v-else class="no-project"><div class="no-project-art"><Film :size="44" /></div><div class="eyebrow">AI STORY STUDIO</div><h1>从一个故事想法，开始一部可玩的作品。</h1><p>设计世界观、创作分支剧情，审查冲突，然后亲自走向不同结局。</p><button class="primary-button" @click="openCreate"><Plus :size="17" />新建互动剧情</button></div>
      </section>

      <aside class="pane activity-pane" :class="{ 'mobile-visible': mobilePane === 'activity' }"><div class="activity-title"><div><span class="eyebrow">LIVE ACTIVITY</span><h2>制作动态</h2></div><Activity :size="19" /></div><div v-if="project" class="activity-content"><div class="mode-explain"><span :class="project.mode === 'ai' ? 'ai-indicator' : 'replay-indicator'"></span><strong>{{ project.mode === 'ai' ? '真实 AI 制作' : '预设 Replay 演示' }}</strong><p>{{ project.mode === 'ai' ? '调用 DeepSeek，角色通过 task 接收任务并写入文件。' : '使用固定样本，不发送模型请求；验收和构建流程相同。' }}</p></div><div class="role-strip"><div class="section-head">当前角色</div><strong>{{ project.activeRole ? roleNames[project.activeRole] ?? project.activeRole : '等待下一项任务' }}</strong><small>{{ project.tasks.length }} 项任务已登记</small></div><div class="event-list"><div v-for="item in [...events].reverse()" :key="item.id" class="event-row"><span class="event-dot" :class="item.kind"></span><div><strong>{{ item.message }}</strong><small>{{ new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }} · {{ item.kind }}</small></div></div><p v-if="!events.length" class="muted-note">任务事件将显示在这里。</p></div><button v-if="isActive" class="stop-button" :disabled="busy" @click="action('cancel')"><Pause :size="15" />停止制作</button></div><div v-else class="activity-empty"><CircleHelp :size="22" /><span>创建或选择项目后查看制作过程</span></div></aside>
    </main>
    <div v-if="error" class="toast" role="alert"><span>{{ error }}</span><button title="关闭提示" @click="error = ''"><X :size="17" /></button></div>
    <div v-if="showCreate" class="modal-backdrop" @click.self="showCreate = false"><div class="create-dialog" role="dialog" aria-modal="true" aria-label="创建互动剧情"><div class="dialog-head"><div><div class="eyebrow">NEW PROJECT</div><h2>创建互动剧情</h2></div><button class="icon-button" title="关闭" @click="showCreate = false"><X :size="20" /></button></div><div class="dialog-scroll"><label>制作模式</label><div class="segment"><button :class="{ active: draft.mode === 'replay' }" @click="setMode('replay')">Replay 演示</button><button :class="{ active: draft.mode === 'ai' }" @click="setMode('ai')">AI 实时制作</button></div><p class="form-note">{{ draft.mode === 'replay' ? '使用固定的“失联太空站”样本，免费、稳定地体验完整流程。' : aiConfigured ? '将调用本机配置的 DeepSeek API。模型生成时间与结果可能变化。' : '尚未检测到 DEEPSEEK_API_KEY；请先在本机配置模型密钥。' }}</p><label>作品名称<input v-model="draft.title" :readonly="draft.mode === 'replay'"></label><label>故事创意<textarea v-model="draft.premise" rows="3" :readonly="draft.mode === 'replay'"></textarea></label><label>世界规则<textarea v-model="draft.worldRules" rows="3" :readonly="draft.mode === 'replay'"></textarea></label><div class="form-grid"><label>题材<input v-model="draft.genre" :readonly="draft.mode === 'replay'"></label><label>目标玩家<input v-model="draft.audience" :readonly="draft.mode === 'replay'"></label></div><div class="form-grid three"><label>角色<input v-model.number="draft.characterCount" type="number" min="2" max="4" :readonly="draft.mode === 'replay'"></label><label>场景<input v-model.number="draft.sceneCount" type="number" min="6" max="10" :readonly="draft.mode === 'replay'"></label><label>结局<input v-model.number="draft.endingCount" type="number" min="2" max="3" :readonly="draft.mode === 'replay'"></label></div><label v-if="draft.mode === 'replay'">演示样本<select v-model="draft.replayScenario"><option value="normal">正常完成</option><option value="defect">故障演示：冲突与局部返工</option></select></label></div><div class="dialog-footer"><button class="secondary-button" @click="showCreate = false">取消</button><button class="primary-button" :disabled="busy || (draft.mode === 'ai' && !aiConfigured)" @click="create"><Sparkles :size="17" />开始制作</button></div></div></div>
  </div>
</template>
