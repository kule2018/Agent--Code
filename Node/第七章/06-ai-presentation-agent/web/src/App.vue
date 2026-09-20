<script setup lang="ts">
import {
	AlertCircle,
	ArrowRight,
	Check,
	ChevronRight,
	CircleDashed,
	Download,
	FileText,
	History,
	LayoutTemplate,
	LoaderCircle,
	PanelLeft,
	Play,
	Plus,
	RefreshCw,
	RotateCcw,
	Sparkles,
	Upload,
	X
} from '@lucide/vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from './api'
import type {
	CreatePresentationInput,
	OutlineVersion,
	PageTask,
	Presentation,
	PresentationChangePlan,
	PresentationStatus
} from './types'

const tasks = ref<Presentation[]>([])
const selected = ref<Presentation | null>(null)
const selectedPageId = ref<string | null>(null)
const activeView = ref<'outline' | 'pages' | 'source'>('outline')
const aiAvailable = ref(false)
const modelName = ref('deepseek-v4-flash')
const busy = ref(false)
const error = ref('')
const reviewFeedback = ref('')
const pageFeedback = ref('')
const changeInstruction = ref('')
const lastChangePlan = ref<PresentationChangePlan | null>(null)

const form = reactive<CreatePresentationInput>({
	modelMode: 'replay',
	topic: '',
	audience: '',
	pageCount: 5,
	additionalRequirements: '',
	sourceText: '',
	sourceName: '粘贴内容'
})

const statusMap: Record<PresentationStatus, string> = {
	creating_outline: '正在生成大纲',
	waiting_review: '等待大纲审核',
	generating_pages: '正在制作页面',
	partially_completed: '部分页面失败',
	completed: '页面制作完成',
	rejected: '任务已结束',
	exported: '已经导出'
}

const currentOutline = computed<OutlineVersion | null>(() => {
	if (!selected.value) return null
	return (
		selected.value.outlines.find(
			(item) => item.version === selected.value?.currentOutlineVersion
		) ?? null
	)
})

const currentPages = computed(() =>
	(selected.value?.pages ?? [])
		.filter(
			(page) => page.outlineVersion === selected.value?.currentOutlineVersion
		)
		.sort((a, b) => a.order - b.order)
)

const selectedPage = computed<PageTask | null>(() => {
	return (
		currentPages.value.find((page) => page.pageId === selectedPageId.value) ??
		currentPages.value[0] ??
		null
	)
})

const selectedArtifact = computed(() =>
	selectedPage.value?.artifacts.find(
		(item) => item.artifactId === selectedPage.value?.currentArtifactId
	)
)

const completedCount = computed(
	() => currentPages.value.filter((page) => page.status === 'completed').length
)

const progress = computed(() =>
	currentPages.value.length
		? Math.round((completedCount.value / currentPages.value.length) * 100)
		: 0
)

const effectiveSlideTheme = computed(() => {
	const theme = selected.value?.theme
	if (!theme) return null
	return {
		...theme,
		...(selectedPage.value?.styleOverride ?? {})
	}
})

const slideStyle = computed<Record<string, string>>(() => {
	const theme = effectiveSlideTheme.value
	if (!theme) return {} as Record<string, string>
	const isCover = selectedPage.value?.order === 1
	const hasPageOverride = Boolean(selectedPage.value?.styleOverride)
	return {
		'--slide-bg': `#${isCover && !hasPageOverride ? theme.coverBackgroundColor : theme.backgroundColor}`,
		'--slide-text': `#${isCover && !hasPageOverride ? theme.coverTextColor : theme.textColor}`,
		'--slide-muted': `#${isCover && !hasPageOverride ? theme.coverMutedColor : theme.mutedColor}`,
		'--slide-accent': `#${theme.accentColor}`,
		'--slide-font': theme.bodyFontFace,
		'--slide-heading-font': theme.headFontFace
	}
})

const changeScopeLabel: Record<PresentationChangePlan['scope'], string> = {
	global_content: '全局内容',
	visual_theme: '视觉主题',
	single_page: '单页内容',
	single_page_style: '单页样式'
}

function loadExample() {
	Object.assign(form, {
		topic: 'Agent 大模型课程企业发布方案',
		audience: '企业技术负责人和研发管理者',
		pageCount: 5,
		additionalRequirements: '内容强调可落地性、风险控制和持久化执行。',
		sourceName: 'Agent 课程发布资料.md',
		sourceText:
			'# Agent 大模型 0～1 系统课\n\n课程覆盖模型调用、RAG、MCP、Agent Runtime、LangChain、LangGraph、Memory 与企业工作流。\n\n课程中的 Agent 不只生成文字，还需要调用工具、维护状态、等待人工审核、在失败后继续执行，并通过确定性代码完成最终验收。\n\n企业落地时需要重点关注权限隔离、执行预算、证据校验、版本管理、人工确认和可观察性。'
	})
}

async function loadTasks(preferredId?: string) {
	const list = await api.list()
	tasks.value = list
	const id = preferredId ?? selected.value?.id
	if (id) {
		selected.value = list.find((task) => task.id === id) ?? null
	}
}

async function selectTask(task: Presentation) {
	error.value = ''
	lastChangePlan.value = null
	selected.value = await api.get(task.id)
	selectedPageId.value = null
	activeView.value = selected.value.pages.length ? 'pages' : 'outline'
}

function createNew() {
	selected.value = null
	selectedPageId.value = null
	error.value = ''
	lastChangePlan.value = null
	activeView.value = 'outline'
}

/** 创建一个新的制作任务，并初始化进入大纲编辑阶段。 */
async function createTask() {
	// 使用统一的异步状态处理函数，管理请求过程中的 loading、错误等状态
	await run(async () => {
		// 调用后端接口，根据当前表单数据创建任务
		const task = await api.create({ ...form })
		// 保存当前创建成功的任务，供后续页面使用
		selected.value = task
		// 加载该任务关联的数据，例如已有的大纲、页面等信息
		await loadTasks(task.id)
		// 创建完成后，将当前视图切换到大纲编辑页面
		activeView.value = 'outline'
	})
}

async function review(decision: 'approve' | 'revise' | 'reject') {
	if (!selected.value || !currentOutline.value) return
	await run(async () => {
		selected.value = await api.review(selected.value!.id, {
			decision,
			outlineVersion: currentOutline.value!.version,
			feedback: reviewFeedback.value
		})
		reviewFeedback.value = ''
		await loadTasks(selected.value.id)
		activeView.value = selected.value.pages.length ? 'pages' : 'outline'
	})
}

async function continuePages() {
	if (!selected.value) return
	await run(async () => {
		selected.value = await api.continuePages(selected.value!.id)
		await loadTasks(selected.value.id)
		activeView.value = 'pages'
	})
}

async function revisePage() {
	if (!selected.value || !selectedPage.value) return
	await run(async () => {
		selected.value = await api.revisePage(
			selected.value!.id,
			selectedPage.value!.pageId,
			pageFeedback.value
		)
		pageFeedback.value = ''
		await loadTasks(selected.value.id)
	})
}

async function applyNaturalLanguageChange() {
	if (!selected.value || !changeInstruction.value.trim()) return
	await run(async () => {
		const result = await api.applyChange(
			selected.value!.id,
			changeInstruction.value.trim()
		)
		selected.value = result.presentation
		lastChangePlan.value = result.plan
		changeInstruction.value = ''
		await loadTasks(result.presentation.id)

		if (result.plan.scope === 'global_content') {
			selectedPageId.value = null
			activeView.value = 'outline'
		}
		if (result.plan.scope === 'visual_theme') {
			activeView.value = currentPages.value.length ? 'pages' : 'outline'
		}
		if (
			result.plan.scope === 'single_page' ||
			result.plan.scope === 'single_page_style'
		) {
			activeView.value = 'pages'
			selectedPageId.value =
				currentPages.value.find(
					(page) => page.order === result.plan.targetPageNumber
				)?.pageId ?? null
		}
	})
}

async function exportPptx() {
	if (!selected.value) return
	await run(async () => {
		selected.value = await api.export(selected.value!.id)
		await loadTasks(selected.value.id)
		window.open(api.downloadUrl(selected.value.id), '_blank')
	})
}

async function onFile(event: Event) {
	const input = event.target as HTMLInputElement
	const file = input.files?.[0]
	if (!file) return
	form.sourceText = await file.text()
	form.sourceName = file.name
}

async function run(operation: () => Promise<void>) {
	busy.value = true
	error.value = ''
	try {
		await operation()
	} catch (cause) {
		error.value = cause instanceof Error ? cause.message : '操作失败'
	} finally {
		busy.value = false
	}
}

function formatTime(value: string) {
	return new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit'
	}).format(new Date(value))
}

onMounted(async () => {
	await run(async () => {
		const meta = await api.meta()
		aiAvailable.value = meta.aiAvailable
		modelName.value = meta.model
		form.modelMode =
			meta.defaultMode === 'ai' && meta.aiAvailable ? 'ai' : 'replay'
		await loadTasks()
		if (tasks.value[0]) await selectTask(tasks.value[0])
	})
})
</script>

<template>
	<div class="app-shell">
		<header class="topbar">
			<div class="brand-lockup">
				<div class="brand-mark"><LayoutTemplate :size="19" /></div>
				<div>
					<strong>DeckFlow</strong>
					<span>AI 演示文稿工作流</span>
				</div>
			</div>
			<div class="topbar-meta">
				<span class="mode-dot"></span>
				{{
					(selected?.modelMode ?? form.modelMode) === 'replay'
						? 'Replay 教学模式'
						: `${modelName} AI 模式`
				}}
			</div>
		</header>

		<main class="workspace">
			<aside class="task-rail scroll-region">
				<div class="rail-heading">
					<div>
						<span class="eyebrow">WORKSPACE</span>
						<h2>制作任务</h2>
					</div>
					<button class="icon-button" title="新建任务" @click="createNew">
						<Plus :size="18" />
					</button>
				</div>

				<button
					v-for="task in tasks"
					:key="task.id"
					class="task-item"
					:class="{ active: selected?.id === task.id }"
					@click="selectTask(task)"
				>
					<span class="task-icon"><FileText :size="16" /></span>
					<span class="task-copy">
						<strong>{{ task.requirements.topic }}</strong>
						<small
							>{{ task.modelMode === 'ai' ? 'AI' : 'Replay' }} ·
							{{ statusMap[task.status] }} ·
							{{ formatTime(task.updatedAt) }}</small
						>
					</span>
					<ChevronRight :size="15" />
				</button>

				<div v-if="!tasks.length" class="rail-empty">
					<PanelLeft :size="22" />
					<span>还没有制作任务</span>
				</div>
			</aside>

			<section class="studio scroll-region">
				<div v-if="!selected" class="create-view">
					<div class="create-heading">
						<span class="eyebrow">NEW PRESENTATION</span>
						<h1>把一份资料，交给可恢复的 Agent 工作流</h1>
						<p>先生成大纲，人工确认方向，再逐页制作并导出可编辑文件。</p>
					</div>

					<div class="mode-selector">
						<div>
							<strong>内容生成模式</strong>
							<span>两种模式共用同一套工作流、数据库和导出逻辑</span>
						</div>
						<div class="segmented-control">
							<button
								:class="{ active: form.modelMode === 'replay' }"
								@click="form.modelMode = 'replay'"
							>
								Replay
							</button>
							<button
								:class="{ active: form.modelMode === 'ai' }"
								:disabled="!aiAvailable"
								:title="
									aiAvailable
										? `使用 ${modelName}`
										: '请先配置 DEEPSEEK_API_KEY'
								"
								@click="form.modelMode = 'ai'"
							>
								AI <small v-if="!aiAvailable">未配置</small>
							</button>
						</div>
					</div>

					<div class="form-grid">
						<label class="field field-wide">
							<span>演示主题</span>
							<input
								v-model="form.topic"
								placeholder="例如：Agent 大模型课程企业发布方案"
							/>
						</label>
						<label class="field">
							<span>目标观众</span>
							<input v-model="form.audience" placeholder="企业技术负责人" />
						</label>
						<label class="field compact-field">
							<span>页数</span>
							<input
								v-model.number="form.pageCount"
								type="number"
								min="3"
								max="12"
							/>
						</label>
						<label class="field field-wide">
							<span>其他制作要求</span>
							<input
								v-model="form.additionalRequirements"
								placeholder="需要强调的内容、语气或结构"
							/>
						</label>
						<label class="field field-wide">
							<span>参考资料</span>
							<textarea
								v-model="form.sourceText"
								rows="10"
								placeholder="粘贴 Markdown 或文本资料"
							></textarea>
						</label>
					</div>

					<div class="create-actions">
						<label class="secondary-button file-button">
							<Upload :size="16" /> 上传资料
							<input
								type="file"
								accept=".md,.txt,text/plain,text/markdown"
								@change="onFile"
							/>
						</label>
						<button class="secondary-button" @click="loadExample">
							<Sparkles :size="16" /> 载入示例
						</button>
						<button class="primary-button" :disabled="busy" @click="createTask">
							<LoaderCircle v-if="busy" class="spin" :size="17" />
							<Play v-else :size="17" />
							开始制作
						</button>
					</div>
				</div>

				<template v-else>
					<div class="studio-heading">
						<div>
							<span class="eyebrow"
								>{{ selected.id }} ·
								{{ selected.modelMode === 'ai' ? 'AI' : 'REPLAY' }}</span
							>
							<h1>{{ selected.requirements.topic }}</h1>
						</div>
						<span class="status-badge" :data-status="selected.status">
							{{ statusMap[selected.status] }}
						</span>
					</div>

					<nav class="view-tabs">
						<button
							:class="{ active: activeView === 'outline' }"
							@click="activeView = 'outline'"
						>
							大纲
						</button>
						<button
							:class="{ active: activeView === 'pages' }"
							@click="activeView = 'pages'"
						>
							页面
						</button>
						<button
							:class="{ active: activeView === 'source' }"
							@click="activeView = 'source'"
						>
							原始资料
						</button>
					</nav>

					<div v-if="activeView === 'outline'" class="content-view">
						<div v-if="currentOutline" class="outline-header">
							<div>
								<span>Outline v{{ currentOutline.version }}</span>
								<h2>{{ currentOutline.title }}</h2>
							</div>
							<small>{{ currentOutline.slides.length }} 页</small>
						</div>
						<div class="outline-list">
							<article
								v-for="slide in currentOutline?.slides"
								:key="slide.pageId"
								class="outline-row"
							>
								<span class="outline-number">{{
									String(slide.order).padStart(2, '0')
								}}</span>
								<div>
									<h3>{{ slide.title }}</h3>
									<p>{{ slide.purpose }}</p>
									<ul>
										<li v-for="point in slide.keyPoints" :key="point">
											{{ point }}
										</li>
									</ul>
								</div>
							</article>
						</div>
					</div>

					<div v-else-if="activeView === 'pages'" class="pages-view">
						<div class="page-strip">
							<button
								v-for="page in currentPages"
								:key="page.pageId"
								:class="{ active: selectedPage?.pageId === page.pageId }"
								@click="selectedPageId = page.pageId"
							>
								<span>{{ page.order }}</span>
								<strong>{{ page.title }}</strong>
								<small :data-page-status="page.status">{{ page.status }}</small>
							</button>
						</div>

						<div
							v-if="selectedPage"
							class="slide-canvas"
							:class="{ failed: selectedPage.status === 'failed' }"
							:style="slideStyle"
							:data-layout="effectiveSlideTheme?.layoutStyle"
							:data-title-align="effectiveSlideTheme?.titleAlign"
							:data-density="effectiveSlideTheme?.density"
						>
							<div class="slide-kicker">
								PAGE {{ String(selectedPage.order).padStart(2, '0') }}
							</div>
							<template v-if="selectedArtifact">
								<h2>{{ selectedArtifact.title }}</h2>
								<p class="slide-subtitle">{{ selectedArtifact.subtitle }}</p>
								<ul class="slide-bullets">
									<li v-for="item in selectedArtifact.bullets" :key="item">
										{{ item }}
									</li>
								</ul>
							</template>
							<div v-else class="slide-placeholder">
								<AlertCircle
									v-if="selectedPage.status === 'failed'"
									:size="28"
								/>
								<CircleDashed v-else :size="28" />
								<strong>{{
									selectedPage.status === 'failed'
										? '本页制作失败'
										: '本页尚未生成'
								}}</strong>
								<span>{{
									selectedPage.lastError || '等待 Agent 执行页面任务'
								}}</span>
							</div>
							<div class="slide-footer">
								Outline v{{ selectedPage.outlineVersion }} · Revision
								{{ selectedPage.pageRevision }}
							</div>
						</div>
					</div>

					<div v-else class="source-view">
						<div class="source-meta">
							<FileText :size="18" /> {{ selected.requirements.sourceName }}
						</div>
						<pre>{{ selected.requirements.sourceText }}</pre>
					</div>
				</template>
			</section>

			<aside class="inspector scroll-region">
				<template v-if="selected">
					<div class="inspector-section">
						<span class="eyebrow">WORKFLOW</span>
						<div class="progress-copy">
							<strong>页面进度</strong
							><span>{{ completedCount }} / {{ currentPages.length }}</span>
						</div>
						<div class="progress-track">
							<i :style="{ width: `${progress}%` }"></i>
						</div>
						<div class="theme-meta">
							<span>视觉主题</span>
							<strong
								>{{ selected.theme.name
								}}{{ selected.theme.preset === 'custom' ? ' · AI 生成' : '' }} ·
								v{{ selected.theme.revision }}</strong
							>
						</div>
						<div
							v-if="selectedPage?.styleOverride"
							class="theme-meta page-style-meta"
						>
							<span>当前页样式</span>
							<strong
								>单页覆盖 · v{{ selectedPage.styleOverride.revision }}</strong
							>
						</div>
					</div>

					<div class="inspector-section action-panel change-panel">
						<div class="section-title">
							<Sparkles :size="16" />
							<h3>自然语言修改</h3>
						</div>
						<textarea
							v-model="changeInstruction"
							rows="4"
							placeholder="例如：主题改成企业 Agent 落地方案 / 第二页使用绿色背景 / 第 2 页突出业务收益"
						></textarea>
						<button
							class="primary-button full"
							:disabled="busy || !changeInstruction.trim()"
							@click="applyNaturalLanguageChange"
						>
							<Sparkles :size="16" /> 应用修改
						</button>
						<div v-if="lastChangePlan" class="change-result">
							<strong>{{ changeScopeLabel[lastChangePlan.scope] }}</strong>
							<span>{{ lastChangePlan.reason }}</span>
						</div>
					</div>

					<div
						v-if="selected.status === 'waiting_review'"
						class="inspector-section action-panel"
					>
						<h3>审核 Outline v{{ currentOutline?.version }}</h3>
						<p>当前工作流已暂停。确认方向以后，再继续制作页面。</p>
						<textarea
							v-model="reviewFeedback"
							rows="4"
							placeholder="要求修改时，请填写具体意见"
						></textarea>
						<button
							class="primary-button full"
							:disabled="busy"
							@click="review('approve')"
						>
							<Check :size="16" /> 批准并制作页面
						</button>
						<div class="button-row">
							<button
								class="secondary-button"
								:disabled="busy || !reviewFeedback.trim()"
								@click="review('revise')"
							>
								<RefreshCw :size="16" /> 要求修改
							</button>
							<button
								class="danger-button"
								:disabled="busy"
								@click="review('reject')"
							>
								<X :size="16" /> 拒绝
							</button>
						</div>
					</div>

					<div
						v-if="selected.status === 'partially_completed'"
						class="inspector-section action-panel warning-panel"
					>
						<h3>存在失败页面</h3>
						<p>已完成页面会保留。继续执行只会处理失败或未完成的页面。</p>
						<button
							class="primary-button full"
							:disabled="busy"
							@click="continuePages"
						>
							<RotateCcw :size="16" /> 继续未完成页面
						</button>
					</div>

					<div
						v-if="selectedPage?.status === 'completed'"
						class="inspector-section action-panel"
					>
						<h3>单页修改</h3>
						<p>只重做当前页面，其他页面产物保持不变。</p>
						<textarea
							v-model="pageFeedback"
							rows="3"
							placeholder="例如：减少技术术语，突出业务收益"
						></textarea>
						<button
							class="secondary-button full"
							:disabled="busy || !pageFeedback.trim()"
							@click="revisePage"
						>
							<RefreshCw :size="16" /> 生成新 Revision
						</button>
					</div>

					<div
						v-if="['completed', 'exported'].includes(selected.status)"
						class="inspector-section action-panel export-panel"
					>
						<h3>交付文件</h3>
						<p>导出前会校验大纲版本、页面状态和当前 Revision。</p>
						<button
							class="primary-button full"
							:disabled="busy"
							@click="exportPptx"
						>
							<Download :size="16" />
							{{ selected.exportRecord ? '重新导出 PPTX' : '导出 PPTX' }}
						</button>
					</div>

					<div class="inspector-section timeline-section">
						<div class="section-title">
							<History :size="16" />
							<h3>执行记录</h3>
						</div>
						<div class="timeline">
							<div
								v-for="item in [...selected.timeline].reverse()"
								:key="item.id"
								class="timeline-item"
							>
								<i></i>
								<div>
									<strong>{{ item.message }}</strong
									><span>{{ formatTime(item.createdAt) }}</span>
								</div>
							</div>
						</div>
					</div>
				</template>
				<div v-else class="inspector-empty">
					<ArrowRight :size="22" />
					<p>创建任务后，这里会显示审核、失败续做、单页修改和导出操作。</p>
				</div>
			</aside>
		</main>

		<div v-if="error" class="error-toast">
			<AlertCircle :size="17" /><span>{{ error }}</span
			><button @click="error = ''"><X :size="15" /></button>
		</div>
		<div v-if="busy && selected" class="busy-bar">
			<LoaderCircle class="spin" :size="15" /> Agent 正在执行，请稍候
		</div>
	</div>
</template>
