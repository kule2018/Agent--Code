<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Activity, ArrowUp, AudioLines, Check, ChevronDown, Database, Download, FileSpreadsheet, History, Image, LoaderCircle, Mic, Plus, RotateCcw, Square, Upload, Volume2, X } from '@lucide/vue'
import ChartView from './ChartView.vue'
import { api, stream } from './api'
import { Microphone } from './recorder'
import type { ColumnMap, Dataset, Mode, PictureFacts, Report, Session, UploadPreview } from '../../shared/types'

const datasets = ref<Dataset[]>([]), sessions = ref<Session[]>([]), selected = ref<Dataset | null>(null), session = ref<Session | null>(null)
const mode = ref<Mode>('replay'), question = ref(''), busy = ref(false), importing = ref(false), stage = ref(''), error = ref('')
const report = ref<Report | null>(null), tab = ref('chart'), sidebar = ref('data'), messages = ref<HTMLElement>(), rows = ref<Record<string, unknown>[]>([])
const meta = ref({ ai: false, speech: false, vision: false, model: 'deepseek-v4-flash' })
const upload = ref<UploadPreview | null>(null), sheetName = ref(''), mapping = ref<ColumnMap>({ date: '', region: '', product: '', paid: '', refund: '' })
const fileInput = ref<HTMLInputElement>(), imageInput = ref<HTMLInputElement>()
const picture = ref<PictureFacts | null>(null), pictureUrl = ref(''), comparison = ref<any>(null), pictureBusy = ref(false)
const recording = ref(false), recognizing = ref(false), seconds = ref(0), level = ref(0)
const speaking = ref(false), playbackBlocked = ref(false)
const sheet = computed(() => upload.value?.sheets.find(s => s.name === sheetName.value))
const activeData = computed(() => selected.value)
const reports = computed(() => session.value?.reports || [])
const tableKeys = computed(() => Object.keys((tab.value === 'raw' ? report.value?.evidence?.rows : report.value?.table)?.[0] || {}))
const displayedRows = computed(() => tab.value === 'raw' ? report.value?.evidence?.rows || [] : report.value?.table || [])
let analysisAbort: AbortController | undefined, speechAbort: AbortController | undefined, recognitionSocket: WebSocket | undefined, microphone: Microphone | undefined
let voiceId = '', recordingTimer: ReturnType<typeof setInterval> | undefined, epoch = 0, audio: HTMLAudioElement | undefined, queue: string[] = [], audioRunning = false, synthesisDone = false
const mappingNames: Record<keyof ColumnMap, string> = { date: '销售日期', region: '区域', product: '商品名称', paid: '实付金额（元）', refund: '退款金额（元）' }
const examples = ['哪些区域连续两个月净销售额下降？', '只看华东，哪些商品贡献了主要降幅？', '9月全部区域实付金额是多少？']

async function refresh() { [datasets.value, sessions.value, meta.value] = await Promise.all([api<Dataset[]>('/datasets'), api<Session[]>('/sessions'), api<typeof meta.value>('/meta')]) }
function fail(e: unknown) { if ((e as Error).name !== 'AbortError') error.value = (e as Error).message }

/** 切换数据集时创建新会话，旧对话继续固定引用原数据版本。 */
async function selectDataset(dataset: Dataset) {
  stop(); selected.value = dataset; session.value = null; report.value = null; comparison.value = null; error.value = ''; tab.value = 'chart'
  rows.value = await api<Record<string, unknown>[]>(`/datasets/${dataset.id}/rows`)
}
async function newSession() {
  if (!selected.value || selected.value.status !== 'ready') return
  stop(); error.value = ''; report.value = null
  session.value = await api<Session>('/sessions', { method: 'POST', body: JSON.stringify({ datasetId: selected.value.id }) })
  await refresh()
}
async function openSession(value: Session) {
  stop(); error.value = ''; session.value = await api<Session>(`/sessions/${value.id}`)
  selected.value = datasets.value.find(d => d.id === value.datasetId) || null
  report.value = session.value.reports.at(-1) || null; tab.value = 'chart'; comparison.value = null
  if (selected.value) rows.value = await api<Record<string, unknown>[]>(`/datasets/${selected.value.id}/rows`)
}

/** 上传先预览工作表和字段，确认映射以后才导入。 */
async function uploadFile(file?: File) {
  if (!file) return
  error.value = ''; importing.value = true
  try { const form = new FormData(); form.append('file', file); upload.value = await api<UploadPreview>('/uploads', { method: 'POST', body: form }); chooseSheet(upload.value.sheets[0].name) }
  catch (e) { fail(e) } finally { importing.value = false; if (fileInput.value) fileInput.value.value = '' }
}
function chooseSheet(name: string) { sheetName.value = name; mapping.value = { ...upload.value!.sheets.find(s => s.name === name)!.suggested } }
async function confirmImport() {
  importing.value = true; error.value = ''
  try {
    const result = await api<{ dataset: Dataset; repeated: boolean }>('/datasets', { method: 'POST', body: JSON.stringify({ uploadId: upload.value!.id, sheet: sheetName.value, mapping: mapping.value }) })
    upload.value = null; await refresh(); await selectDataset(result.dataset)
    stage.value = result.repeated ? '同一份内容已导入，继续使用已有版本' : '文件导入完成'
  } catch (e) { fail(e) } finally { importing.value = false }
}

/** 发送分析问题，持续接收执行进度；使用本轮标识隔离旧请求。 */
async function ask(text = question.value) {
  if (!text.trim() || busy.value || recording.value || recognizing.value || !selected.value) return
  stopSpeech(); error.value = ''
  const controller = new AbortController()
  try {
    if (!session.value) session.value = await api<Session>('/sessions', { method: 'POST', body: JSON.stringify({ datasetId: selected.value.id }) })
    analysisAbort = controller
    const run = ++epoch
    busy.value = true; question.value = text; stage.value = '准备本轮分析'
    let received = false
    await stream(`/sessions/${session.value.id}/analyze`, { question: text, mode: mode.value }, controller.signal, (event, data) => {
      if (run !== epoch || controller.signal.aborted) return
      if (event === 'progress') stage.value = data.message
      if (event === 'error') throw new Error(data.message)
      if (event === 'report') { received = true; session.value!.reports.push(data); report.value = data; tab.value = 'chart'; question.value = ''; stage.value = data.status === 'completed' ? '分析完成' : '需要补充信息' }
    })
    if (!received && !controller.signal.aborted) throw new Error('没有收到完整分析结果，请重试')
    await refresh(); await nextTick(); messages.value?.scrollTo({ top: messages.value.scrollHeight, behavior: 'smooth' })
  } catch (e) { fail(e) } finally { if (analysisAbort === controller) { busy.value = false; analysisAbort = undefined } }
}
function stopSpeech() {
  speechAbort?.abort(); speechAbort = undefined; queue = []; synthesisDone = true; audioRunning = false
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); audio = undefined }
  speaking.value = false; playbackBlocked.value = false
}
function stop() {
  epoch++; analysisAbort?.abort(); busy.value = false; stopSpeech(); cancelRecording()
  stage.value = '已停止本轮'
}
function showReport(value: Report) { stopSpeech(); report.value = value; tab.value = 'chart'; comparison.value = null }
function download(kind: 'export' | 'csv') { if (session.value && report.value) window.open(`/api/sessions/${session.value.id}/reports/${report.value.id}/${kind}`, '_blank') }

async function inspectImage(file?: File) {
  if (!file) return
  pictureBusy.value = true; error.value = ''
  try {
    const form = new FormData(); form.append('file', file); form.append('mode', mode.value)
    picture.value = await api<PictureFacts>('/images', { method: 'POST', body: form })
    if (pictureUrl.value) URL.revokeObjectURL(pictureUrl.value)
    pictureUrl.value = URL.createObjectURL(file)
  } catch (e) { fail(e) } finally { pictureBusy.value = false; if (imageInput.value) imageInput.value.value = '' }
}
async function comparePicture() {
  pictureBusy.value = true; error.value = ''
  try { comparison.value = await api('/images/compare', { method: 'POST', body: JSON.stringify({ datasetId: selected.value!.id, facts: picture.value }) }); picture.value = null; tab.value = 'picture' }
  catch (e) { fail(e) } finally { pictureBusy.value = false }
}

/** 浏览器只负责音频采集，ASR 最终文本留在输入框由用户确认。 */
async function record() {
  error.value = ''; stopSpeech(); recognizing.value = true
  const id = crypto.randomUUID(); voiceId = id
  try {
    microphone = new Microphone((pcm, amplitude) => { if (voiceId !== id) return; level.value = amplitude; recognitionSocket?.send(JSON.stringify({ event: 'audio', data: { turnId: id, audio: pcm } })) })
    await microphone.prepare()
    if (voiceId !== id) return
    recognitionSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`)
    recognitionSocket.onopen = () => { if (voiceId === id) recognitionSocket?.send(JSON.stringify({ event: 'listen', data: { turnId: id } })) }
    recognitionSocket.onmessage = ({ data }) => {
      const packet = JSON.parse(data)
      if (voiceId !== id || packet.data.turnId !== id) return
      if (packet.event === 'asr.ready') {
        recognizing.value = false; recording.value = true; seconds.value = 0; microphone?.start()
        recordingTimer = setInterval(() => { seconds.value++; if (seconds.value >= 30) void finishRecording() }, 1000)
      }
      if (packet.event === 'asr.partial') question.value = packet.data.text
      if (packet.event === 'asr.final') { question.value = packet.data.text; recognizing.value = false; stage.value = '转写已完成，请核对后确认分析'; cancelRecording() }
      if (packet.event === 'error') { error.value = packet.data.message; cancelRecording() }
    }
    recognitionSocket.onerror = () => { if (voiceId === id) { error.value = '语音连接失败，请检查后端是否启动'; cancelRecording() } }
    recognitionSocket.onclose = () => { if (voiceId === id && (recording.value || recognizing.value)) { error.value = '识别连接已断开，请重新录音'; cancelRecording() } }
  } catch (e) { fail(e); cancelRecording() }
}
async function finishRecording() {
  if (!recording.value) return
  recording.value = false; recognizing.value = true; clearInterval(recordingTimer)
  await microphone?.stop()
  recognitionSocket?.send(JSON.stringify({ event: 'finish', data: { turnId: voiceId } }))
}
function cancelRecording() {
  const oldId = voiceId; voiceId = ''; clearInterval(recordingTimer); void microphone?.stop(true); microphone = undefined
  if (recognitionSocket?.readyState === WebSocket.OPEN) recognitionSocket.send(JSON.stringify({ event: 'cancel', data: { turnId: oldId } }))
  recognitionSocket?.close(); recognitionSocket = undefined; recording.value = false; recognizing.value = false; level.value = 0
}

/** 逐句接收合成地址，串行播放；停止时清空队列并取消后续合成。 */
async function speak() {
  if (!report.value || !session.value) return
  stopSpeech(); error.value = ''; synthesisDone = false; speaking.value = true
  const controller = new AbortController(); speechAbort = controller
  try {
    await stream(`/sessions/${session.value.id}/reports/${report.value.id}/speech`, {}, controller.signal, (event, data) => {
      if (speechAbort !== controller || controller.signal.aborted) return
      if (event === 'audio') { queue.push(data.audioUrl); void playNext(controller) }
      if (event === 'error') throw new Error(data.message)
      if (event === 'done') synthesisDone = true
    })
    synthesisDone = true; if (!audioRunning && !queue.length) speaking.value = false
  } catch (e) { fail(e); stopSpeech() }
}
async function playNext(controller = speechAbort) {
  if (!controller || controller.signal.aborted || audioRunning || !queue.length) return
  audioRunning = true; audio = new Audio(queue.shift()); const current = audio
  current.onended = () => { if (controller !== speechAbort) return; audioRunning = false; audio = undefined; void playNext(controller); if (synthesisDone && !queue.length) speaking.value = false }
  current.onerror = () => { if (controller !== speechAbort) return; error.value = '音频加载失败，分析文字仍可查看'; stopSpeech() }
  try { await current.play(); playbackBlocked.value = false } catch { playbackBlocked.value = true }
}
async function resumePlayback() { try { await audio?.play(); playbackBlocked.value = false } catch (e) { fail(e) } }

onMounted(async () => { try { await refresh(); if (datasets.value.length) await selectDataset(datasets.value.find(d => d.status === 'ready') || datasets.value[0]) } catch (e) { fail(e) } })
onBeforeUnmount(() => { stop(); if (pictureUrl.value) URL.revokeObjectURL(pictureUrl.value) })
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <div class="brand"><span class="brand-icon"><Activity :size="23" /></span><strong>观数</strong><span class="brand-divider"></span><span>AI 数据分析工作台</span></div>
      <div class="top-actions"><span class="local-badge">本地工作区</span><div class="segmented" aria-label="分析模式"><button :class="{ active: mode === 'replay' }" :disabled="busy" @click="mode = 'replay'">Replay 演示</button><button :class="{ active: mode === 'ai' }" :disabled="busy" @click="mode = 'ai'">AI 分析</button></div></div>
    </header>
    <div v-if="error" class="error-banner" role="alert">{{ error }}<button aria-label="关闭错误" @click="error = ''"><X :size="16" /></button></div>
    <div class="columns">
      <aside class="sidebar">
        <div class="sidebar-tabs"><button :class="{ selected: sidebar === 'data' }" @click="sidebar = 'data'"><Database :size="16" />数据集</button><button :class="{ selected: sidebar === 'history' }" @click="sidebar = 'history'"><History :size="16" />分析记录</button></div>
        <div class="sidebar-scroll">
          <template v-if="sidebar === 'data'">
            <button class="upload-button" :disabled="importing || busy" @click="fileInput?.click()"><Upload :size="17" />{{ importing ? '正在读取文件' : '上传 Excel / CSV' }}</button>
            <input ref="fileInput" class="hidden" type="file" accept=".xlsx,.csv" @change="uploadFile(($event.target as HTMLInputElement).files?.[0])">
            <div class="section-label">数据文件 <span>{{ datasets.length }}</span></div>
            <button v-for="dataset in datasets" :key="dataset.id" class="dataset-item" :class="{ chosen: selected?.id === dataset.id }" :disabled="busy" @click="selectDataset(dataset)">
              <FileSpreadsheet :size="19" /><div><strong>{{ dataset.name }}</strong><small>{{ dataset.sheet }} · v{{ dataset.version }} · {{ dataset.rowCount }} 行</small><span class="status-tag" :class="dataset.status">{{ dataset.status === 'ready' ? '可分析' : '需要核对' }}</span></div>
            </button>
            <div v-if="!datasets.length" class="sidebar-empty">还没有数据文件</div>
            <div class="sample-links"><span>课程样例</span><a href="/api/samples/sales-demo.xlsx" download><Download :size="14" />销售报表.xlsx</a><a href="/api/samples/sales-demo.csv" download><Download :size="14" />销售报表.csv</a><a href="/api/samples/sales-issues.xlsx" download><Download :size="14" />质量问题样例</a><a href="/api/samples/dashboard.png" download><Download :size="14" />销售看板.png</a></div>
          </template>
          <template v-else>
            <button class="upload-button" :disabled="!selected || busy" @click="newSession"><Plus :size="17" />新建分析会话</button>
            <button v-for="item in sessions" :key="item.id" class="session-item" :class="{ chosen: session?.id === item.id }" :disabled="busy" @click="openSession(item)"><History :size="16" /><div><strong>{{ item.title }}</strong><small>{{ item.reports.length }} 轮分析 · {{ new Date(item.createdAt).toLocaleDateString() }}</small></div></button>
            <div v-if="!sessions.length" class="sidebar-empty">还没有分析记录</div>
          </template>
        </div>
        <div class="sidebar-footer"><span class="dot"></span>{{ mode === 'ai' ? meta.model : '演示问题 · 真实计算' }}</div>
      </aside>

      <main class="analysis-panel">
        <div class="panel-heading"><div><h1>分析会话</h1><p>{{ selected ? selected.name + ' · ' + selected.sheet + ' · v' + selected.version : '选择一份销售报表' }}</p></div><button class="icon-button" title="新建分析会话" :disabled="!selected || busy" @click="newSession"><Plus :size="20" /></button></div>
        <div v-if="selected" class="dataset-summary"><span><Database :size="14" />{{ selected.rowCount }} 条明细</span><span>{{ selected.start }} — {{ selected.end }}</span><span>人民币 · 元</span></div>
        <div ref="messages" class="conversation-scroll">
          <div v-if="!selected" class="empty-state"><span class="empty-icon"><FileSpreadsheet :size="38" /></span><h2>从一份业务报表开始</h2><p>上传销售明细，查看趋势与商品变化</p><button class="primary" @click="fileInput?.click()"><Upload :size="16" />上传文件</button></div>
          <div v-else-if="selected.status !== 'ready'" class="quality-state"><h2>先核对数据，再开始分析</h2><p>发现 {{ selected.issues.length }} 项问题。本版本保留原始记录，查询暂未开放。</p><div v-for="(issue, index) in selected.issues.slice(0, 30)" :key="index" class="issue-row"><span>第 {{ issue.row }} 行</span><strong>{{ issue.field }}</strong><p>{{ issue.message }}</p></div></div>
          <div v-else-if="!reports.length" class="intro-state"><span class="empty-icon"><AudioLines :size="35" /></span><h2>看看数据里发生了什么</h2><p>默认口径：净销售额，已扣除退款</p><div class="question-examples"><button v-for="(text, index) in examples" :key="text" @click="question = text"><span>0{{ index + 1 }}</span>{{ text }}<ArrowUp :size="15" /></button></div></div>
          <article v-for="item in reports" :key="item.id" class="conversation-turn">
            <div class="user-question">{{ item.question }}</div>
            <div class="answer-label"><span class="small-brand"><Activity :size="14" /></span>观数 Agent<span>{{ item.mode === 'ai' ? 'AI 分析' : 'Replay 演示' }}</span></div>
            <p class="answer-text">{{ item.answer }}</p>
            <div v-if="item.evidence" class="answer-source"><Check :size="14" />{{ item.evidence.dataset.name }} · v{{ item.evidence.dataset.version }} · 真实查询</div>
            <button v-if="item.evidence" class="result-link" :class="{ current: report?.id === item.id }" @click="showReport(item)">查看图表与分析依据 →</button>
          </article>
          <div v-if="busy" class="working"><LoaderCircle class="spin" :size="17" />{{ stage }}<span>运行中</span></div>
        </div>
        <div class="composer-zone">
          <div class="composer"><textarea v-model="question" aria-label="分析问题" placeholder="问一个业务问题，例如：哪些区域连续两个月下降？" :disabled="busy || selected?.status !== 'ready'" @keydown.ctrl.enter.prevent="ask()"></textarea><div class="composer-actions"><div class="input-tools"><button class="icon-button" title="上传看板截图" :disabled="!selected || busy || pictureBusy" @click="imageInput?.click()"><Image :size="19" /></button><input ref="imageInput" class="hidden" type="file" accept="image/png,image/jpeg" @change="inspectImage(($event.target as HTMLInputElement).files?.[0])"><button class="icon-button" :class="{ recording }" :title="recording ? '结束录音' : '语音提问'" :disabled="busy || recognizing || !selected || !meta.speech" @click="recording ? finishRecording() : record()"><Square v-if="recording" :size="17" /><Mic v-else :size="19" /></button><span v-if="recording" class="recording-status">录音 {{ seconds }}s <span :style="{ opacity: Math.min(1, 0.3 + level * 4) }">●</span></span><span v-else-if="recognizing" class="muted">正在识别…</span></div><button v-if="busy" class="stop-button" @click="stop"><Square :size="14" />停止本轮</button><button v-else class="send-button" title="确认分析" aria-label="确认分析" :disabled="!question.trim() || selected?.status !== 'ready' || recording || recognizing" @click="ask()"><ArrowUp :size="21" /></button></div></div>
          <div class="composer-foot"><span>{{ stage || '数字来自当前数据集，支持核对查询依据' }}</span><span>{{ mode === 'replay' ? 'Replay' : 'AI' }}</span></div>
        </div>
      </main>

      <aside class="results-panel">
        <div class="panel-heading"><div><h2>分析结果</h2><p>{{ report?.evidence ? report.evidence.spec.start + ' — ' + report.evidence.spec.end : '图表、明细与查询依据' }}</p></div><button class="icon-button" title="导出报告" :disabled="!report" @click="download('export')"><Download :size="19" /></button></div>
        <div class="result-tabs"><button :class="{ selected: tab === 'chart' }" @click="tab = 'chart'">图表</button><button :class="{ selected: tab === 'table' }" @click="tab = 'table'">结果表</button><button :class="{ selected: tab === 'sql' }" @click="tab = 'sql'">依据</button><button v-if="comparison" :class="{ selected: tab === 'picture' }" @click="tab = 'picture'">截图核对</button></div>
        <div class="results-scroll">
          <template v-if="tab === 'picture' && comparison"><h3>截图与原表核对</h3><img :src="pictureUrl" class="picture-preview" alt="已上传的销售看板"><p class="comparison-text">{{ comparison.explanation }}</p><div class="comparison-grid"><span>截图金额<strong>{{ comparison.imageAmount.toLocaleString() }} 元</strong></span><span>原表复算<strong>{{ comparison.total.toLocaleString() }} 元</strong></span></div><h3>核对 SQL</h3><pre>{{ comparison.evidence.sql }}</pre></template>
          <template v-else-if="report">
            <template v-if="tab === 'chart'"><h3>{{ report.chart?.title || '本轮分析' }}</h3><ChartView v-if="report.chart" :chart="report.chart" /><p v-else class="empty-result">{{ report.answer }}</p><div class="report-summary">{{ report.answer }}</div><div class="report-notes"><p v-for="note in report.notes" :key="note">{{ note }}</p></div><div class="report-actions"><button :disabled="speaking || !meta.speech" @click="speak"><Volume2 :size="16" />朗读结果</button><button v-if="speaking" @click="stopSpeech"><Square :size="14" />停止播放</button><button v-if="playbackBlocked" @click="resumePlayback">继续播放</button><button @click="download('export')"><Download :size="15" />导出报告</button></div></template>
            <template v-else-if="tab === 'table' || tab === 'raw'"><div class="table-heading"><h3>{{ tab === 'raw' ? '查询原始结果' : '本轮分析结果' }}</h3><button title="下载结果 CSV" class="icon-button" @click="download('csv')"><Download :size="17" /></button></div><div class="table-wrap"><table><thead><tr><th v-for="key in tableKeys" :key="key">{{ key }}</th></tr></thead><tbody><tr v-for="(row, index) in displayedRows" :key="index"><td v-for="key in tableKeys" :key="key">{{ row[key] ?? '—' }}</td></tr></tbody></table></div><p v-if="!displayedRows.length" class="empty-result">本轮没有有效查询结果</p></template>
            <template v-else-if="tab === 'sql'"><template v-if="report.evidence"><h3>数据与统计口径</h3><dl class="evidence-details"><dt>文件</dt><dd>{{ report.evidence.dataset.name }}</dd><dt>工作表 / 版本</dt><dd>{{ report.evidence.dataset.sheet }} / v{{ report.evidence.dataset.version }}</dd><dt>时间范围</dt><dd>{{ report.evidence.spec.start }} 至 {{ report.evidence.spec.end }}</dd><dt>区域</dt><dd>{{ report.evidence.spec.region || '全部区域' }}</dd><dt>指标</dt><dd>{{ { net: '净销售额（已扣退款）', paid: '实付金额（未扣退款）', refund: '退款金额' }[report.evidence.spec.metric] }}</dd><dt>单位</dt><dd>人民币元</dd><dt>数据校验值</dt><dd class="hash">{{ report.evidence.dataset.checksum }}</dd></dl><h3>只读查询 SQL</h3><pre>{{ report.evidence.sql }}</pre><button class="result-link" @click="tab = 'raw'">查看查询原始结果 →</button><p class="muted">执行耗时 {{ report.evidence.durationMs }}ms</p></template><p v-else class="empty-result">本轮没有生成查询依据</p></template>
          </template>
          <template v-else-if="activeData"><h3>当前数据概览</h3><dl class="evidence-details"><dt>工作表</dt><dd>{{ activeData.sheet }}</dd><dt>记录数量</dt><dd>{{ activeData.rowCount }} 行</dd><dt>区域</dt><dd>{{ activeData.regions.join('、') }}</dd><dt>商品</dt><dd>{{ activeData.products.join('、') }}</dd><dt>质量检查</dt><dd>{{ activeData.status === 'ready' ? '通过' : activeData.issues.length + ' 项待核对' }}</dd></dl><h3>明细预览</h3><div class="table-wrap"><table><thead><tr><th v-for="key in Object.keys(rows[0] || {})" :key="key">{{ key }}</th></tr></thead><tbody><tr v-for="(row, index) in rows.slice(0, 6)" :key="index"><td v-for="key in Object.keys(rows[0] || {})" :key="key">{{ row[key] }}</td></tr></tbody></table></div></template>
          <div v-else class="result-empty"><Database :size="30" /><p>还没有分析结果</p></div>
        </div>
      </aside>
    </div>

    <div v-if="upload" class="modal-backdrop" @click.self="!importing && (upload = null)"><section class="modal" role="dialog" aria-modal="true" aria-label="确认工作表与字段"><header><div><h2>确认工作表与字段</h2><p>{{ upload.filename }}</p></div><button class="icon-button" :disabled="importing" aria-label="关闭" @click="upload = null"><X :size="20" /></button></header><label class="field">工作表<select :value="sheetName" :disabled="importing" @change="chooseSheet(($event.target as HTMLSelectElement).value)"><option v-for="item in upload.sheets" :key="item.name">{{ item.name }}</option></select></label><div class="mapping-grid"><label v-for="(label, key) in mappingNames" :key="key" class="field">{{ label }}<select v-model="mapping[key]" :disabled="importing"><option value="">选择原表字段</option><option v-for="header in sheet?.headers" :key="header">{{ header }}</option></select></label></div><p class="modal-note">首行为表头，每行一条销售明细；金额单位须为元，退款金额须明确填写，空值不会按零处理。</p><div class="table-wrap"><table><thead><tr><th v-for="header in sheet?.headers" :key="header">{{ header }}</th></tr></thead><tbody><tr v-for="(row, index) in sheet?.rows" :key="index"><td v-for="(value, col) in row" :key="col">{{ typeof value === 'object' ? JSON.stringify(value) : value }}</td></tr></tbody></table></div><footer><button class="secondary" :disabled="importing" @click="upload = null">取消</button><button class="primary" :disabled="importing || Object.values(mapping).some(value => !value)" @click="confirmImport"><LoaderCircle v-if="importing" class="spin" :size="16" /><Check v-else :size="16" />确认导入</button></footer></section></div>
    <div v-if="picture" class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="核对截图口径"><header><div><h2>核对截图口径</h2><p>{{ picture.title }}</p></div><button class="icon-button" aria-label="关闭" @click="picture = null"><X :size="20" /></button></header><img :src="pictureUrl" class="picture-preview" alt="待核对销售看板"><div class="mapping-grid"><label class="field">开始日期<input v-model="picture.start" type="date"></label><label class="field">结束日期<input v-model="picture.end" type="date"></label><label class="field">指标<select v-model="picture.metric"><option value="unknown">需要确认</option><option value="paid">实付金额（未扣退款）</option><option value="net">净销售额（已扣退款）</option><option value="refund">退款金额</option></select></label><label class="field">单位<select v-model="picture.unit"><option value="unknown">需要确认</option><option>元</option><option>万元</option></select></label><label class="field">截图金额<input v-model.number="picture.amount" type="number" min="0" step="0.01"></label><label class="field">区域<select v-model="picture.region"><option :value="null">全部区域</option><option v-for="region in selected?.regions" :key="region">{{ region }}</option></select></label></div><div v-if="picture.uncertainties.length" class="modal-note">{{ picture.uncertainties.join('；') }}<button class="result-link" @click="picture.uncertainties = []">已核对上述疑问</button></div><footer><button class="secondary" @click="picture = null">取消</button><button class="primary" :disabled="pictureBusy || !selected" @click="comparePicture"><Check :size="16" />确认并核对原表</button></footer></section></div>
  </div>
</template>
