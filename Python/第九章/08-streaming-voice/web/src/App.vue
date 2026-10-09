<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import {
	Mic,
	Square,
	Send,
	Play,
	Activity,
	Database,
	Volume2,
	RotateCw
} from '@lucide/vue'
import { questionExample, type Packet, type Mode } from '../../shared/protocol'
import { Microphone } from './recorder'
import { PlaybackQueue } from './playback'

const connected = ref(false),
	mode = ref<Mode>('stream'),
	question = ref(questionExample)
const status = ref('等待提问'),
	answer = ref(''),
	warning = ref(''),
	sql = ref('')
const rows = ref<Record<string, unknown>[]>([]),
	recordState = ref('idle'),
	speaking = ref(''),
	blocked = ref(false)
const activeTurnId = ref(''),
	level = ref(0)
const metrics = reactive({
	firstText: null as number | null,
	firstAudio: null as number | null,
	firstPlay: null as number | null,
	total: null as number | null
})
const timeline = ref<{ event: string; ms: number; label: string }[]>([])
const player = ref<HTMLAudioElement>()
let socket: WebSocket,
	microphone: Microphone | undefined,
	playback: PlaybackQueue
let started = 0,
	recordTimer: ReturnType<typeof setTimeout> | undefined
const columns = computed(() =>
	rows.value.length ? Object.keys(rows.value[0]) : []
)
const elapsed = () => Math.round(performance.now() - started)
const format = (value: number | null) =>
	value === null ? '—' : (value / 1000).toFixed(2) + ' s'

/** 页面和服务端约定使用 event + data 消息，所有业务事件带本轮 turnId。 */
function send(event: string, data: Record<string, unknown>) {
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify({ event, data }))
}
function interrupt() {
	const oldId = activeTurnId.value
	activeTurnId.value = ''
	playback?.stop()
	clearTimeout(recordTimer)
	void microphone?.stop(true)
	microphone = undefined
	recordState.value = 'idle'
	level.value = 0
	blocked.value = false
	if (oldId) {
		send('cancel', { turnId: oldId })
		status.value = '已停止本轮'
	}
}
function begin() {
	interrupt()
	const turnId = crypto.randomUUID()
	activeTurnId.value = turnId
	started = performance.now()
	timeline.value = []
	answer.value = ''
	rows.value = []
	sql.value = ''
	warning.value = ''
	Object.assign(metrics, {
		firstText: null,
		firstAudio: null,
		firstPlay: null,
		total: null
	})
	playback.begin(turnId)
	return turnId
}
function ask() {
	if (
		!question.value.trim() ||
		!connected.value ||
		recordState.value !== 'idle'
	)
		return
	const turnId = begin()
	status.value = '已提交问题'
	send('ask', { turnId, question: question.value, mode: mode.value })
}
async function record() {
	if (recordState.value === 'recording') {
		await finishRecording()
		return
	}
	if (!connected.value || recordState.value !== 'idle') return
	const turnId = begin()
	question.value = ''
	recordState.value = 'connecting'
	status.value = '正在连接识别服务'
	const capture = new Microphone((audio, volume) => {
		if (turnId !== activeTurnId.value) return
		level.value = Math.min(volume * 8, 1)
		if (socket.bufferedAmount > 128000) {
			warning.value = '网络发送过慢，已停止录音'
			interrupt()
			return
		}
		send('audio', { turnId, audio })
	})
	microphone = capture
	try {
		await capture.prepare()
		if (turnId !== activeTurnId.value) return
		send('listen', { turnId })
	} catch (error) {
		if (turnId !== activeTurnId.value) return
		warning.value = (error as Error).message
		interrupt()
	}
}
/** 用户停止录音后，释放麦克风并通知服务端完成本次语音识别。 */
async function finishRecording() {
	// 保存当前对话轮次 ID，防止异步操作期间轮次发生变化。
	const id = activeTurnId.value
	// 将录音状态切换为结束中，并清除录音计时器。
	recordState.value = 'finishing'
	clearTimeout(recordTimer)
	// 停止麦克风录音，等待剩余音频块发送完成。
	await microphone?.stop()
	// 释放麦克风引用，并重置音量显示。
	microphone = undefined
	level.value = 0
	// 如果当前轮次已经切换，则不再发送旧轮次的结束事件。
	if (id !== activeTurnId.value) return
	// 通知服务端音频上传结束，等待 ASR 返回最终识别结果。
	send('finish', { turnId: id })
	// 更新页面提示，等待服务端确认完整的识别文本。
	status.value = '正在确认最终识别文字'
}

/** 先核对轮次，再更新页面；迟到的旧事件不会进入文字区和播放队列。 */
function receive(packet: Packet) {
	const { event, data } = packet
	if (!activeTurnId.value || data.turnId !== activeTurnId.value) return
	if (!['answer.delta', 'asr.partial'].includes(event)) {
		timeline.value.push({
			event,
			ms: elapsed(),
			label: data.text || data.sql || event
		})
	}
	if (event === 'status') status.value = data.text
	if (event === 'asr.ready') {
		microphone?.start()
		recordState.value = 'recording'
		status.value = '录音中'
		recordTimer = setTimeout(() => {
			void finishRecording()
		}, 30000)
	}
	if (event === 'asr.partial') question.value = data.text
	if (event === 'asr.final') {
		question.value = data.text
		recordState.value = 'idle'
		status.value = '识别完成，等待确认'
	}
	if (event === 'query.result') {
		rows.value = data.rows
		sql.value = data.sql
	}
	if (event === 'answer.delta') {
		if (metrics.firstText === null) metrics.firstText = elapsed()
		answer.value += data.text
	}
	if (event === 'audio.segment') {
		if (metrics.firstAudio === null) metrics.firstAudio = elapsed()
		playback.push(data as any)
	}
	if (event === 'audio.warning') warning.value = data.text
	if (event === 'done') {
		metrics.total = elapsed()
		status.value = '回答与合成完成'
	}
	if (event === 'error') {
		warning.value = data.text
		interrupt()
		status.value = '本轮未完成'
	}
}
function connect() {
	socket = new WebSocket(
		`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/voice`
	)
	socket.onopen = () => {
		connected.value = true
		warning.value = ''
	}
	socket.onmessage = (event) => receive(JSON.parse(event.data))
	socket.onclose = () => {
		connected.value = false
		interrupt()
		status.value = '连接已断开'
	}
	socket.onerror = () => {
		warning.value = '服务连接失败，请检查 Python 服务终端是否启动成功'
	}
}
onMounted(() => {
	playback = new PlaybackQueue(
		player.value!,
		(text) => {
			speaking.value = text
		},
		() => {
			blocked.value = true
		},
		() => {
			blocked.value = false
			if (metrics.firstPlay === null) metrics.firstPlay = elapsed()
		}
	)
	connect()
})
onBeforeUnmount(() => {
	interrupt()
	socket?.close()
})
</script>

<template>
	<div class="app">
		<header>
			<div class="brand">
				<Activity :size="24" />
				<h1>语音数据分析</h1>
				<span class="chapter">08 / STREAMING</span>
			</div>
			<div class="connection">
				<i :class="{ live: connected }"></i
				>{{ connected ? '服务已连接' : '服务未连接' }}
				<button
					v-if="!connected"
					class="icon"
					title="重新连接"
					@click="connect"
				>
					<RotateCw :size="16" />
				</button>
			</div>
		</header>
		<main>
			<aside>
				<div class="section-title">
					<h2>提问</h2>
					<span>销售数据 · 2026</span>
				</div>
				<div class="modes" aria-label="输出方式">
					<button
						:class="{ selected: mode === 'stream' }"
						@click="mode = 'stream'"
					>
						逐句返回
					</button>
					<button
						:class="{ selected: mode === 'buffered' }"
						@click="mode = 'buffered'"
					>
						完整后返回
					</button>
				</div>
				<label for="question">当前问题</label>
				<textarea
					id="question"
					v-model="question"
					maxlength="2000"
					:disabled="recordState !== 'idle'"
					rows="6"
				></textarea>
				<div class="examples">
					<button
						@click="question = questionExample"
						:disabled="recordState !== 'idle'"
					>
						各区域销售额
					</button>
					<button
						@click="
							question =
								'仅按已导入记录，2026 年 9 月华东未扣退款销售额是多少？'
						"
						:disabled="recordState !== 'idle'"
					>
						只看华东
					</button>
				</div>
				<div class="actions">
					<button
						class="record"
						:disabled="
							!connected || ['connecting', 'finishing'].includes(recordState)
						"
						@click="record"
					>
						<Square v-if="recordState === 'recording'" :size="17" /><Mic
							v-else
							:size="17"
						/>
						{{
							recordState === 'recording'
								? '结束录音'
								: recordState === 'connecting'
									? '连接识别中'
									: '开始录音'
						}}
					</button>
					<button
						class="primary"
						:disabled="!connected || !question.trim() || recordState !== 'idle'"
						@click="ask"
					>
						<Send :size="16" />确认并分析
					</button>
				</div>
				<div class="meter" aria-label="麦克风音量">
					<span
						v-for="i in 30"
						:key="i"
						:class="{ on: i / 30 <= level }"
						:style="{ height: 8 + (i % 5) * 4 + 'px' }"
					></span>
				</div>
				<section class="timing">
					<h2>本轮耗时</h2>
					<dl>
						<div>
							<dt>首段文字</dt>
							<dd>{{ format(metrics.firstText) }}</dd>
						</div>
						<div>
							<dt>首段音频就绪</dt>
							<dd>{{ format(metrics.firstAudio) }}</dd>
						</div>
						<div>
							<dt>首次开始播放</dt>
							<dd>{{ format(metrics.firstPlay) }}</dd>
						</div>
						<div>
							<dt>回答与合成完成</dt>
							<dd>{{ format(metrics.total) }}</dd>
						</div>
					</dl>
				</section>
				<div class="data-source">
					<Database :size="16" /><span
						>已导入记录<br /><small>DuckDB · 只读查询</small></span
					>
				</div>
			</aside>
			<article>
				<div class="answer-head">
					<div>
						<span class="eyebrow">本轮回答</span>
						<h2>{{ status }}</h2>
					</div>
					<button class="stop" @click="interrupt" :disabled="!activeTurnId">
						<Square :size="15" />停止本轮
					</button>
				</div>
				<div v-if="warning" role="alert" class="warning">{{ warning }}</div>
				<div class="answer" :class="{ empty: !answer }">
					{{ answer || '等待本轮分析结果' }}
				</div>
				<div class="audio-bar">
					<Volume2 :size="19" /><span>{{ speaking || '暂无待播放内容' }}</span>
					<button v-if="blocked" @click="playback.resume()">
						<Play :size="16" />继续播放
					</button>
				</div>
				<audio ref="player" hidden></audio>
				<section v-if="rows.length" class="results">
					<h3>查询结果</h3>
					<div class="table-scroll">
						<table>
							<thead>
								<tr>
									<th v-for="column in columns" :key="column">{{ column }}</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="(row, i) in rows" :key="i">
									<td v-for="column in columns" :key="column">
										{{ row[column] }}
									</td>
								</tr>
							</tbody>
						</table>
					</div>
					<details>
						<summary>查看 SQL</summary>
						<pre>{{ sql }}</pre>
					</details>
				</section>
				<section class="events">
					<h3>执行记录</h3>
					<div class="event" v-for="(entry, i) in timeline" :key="i">
						<time>{{ (entry.ms / 1000).toFixed(2) }}s</time
						><code>{{ entry.event }}</code
						><span>{{ entry.label }}</span>
					</div>
					<p v-if="!timeline.length" class="muted">暂无记录</p>
				</section>
			</article>
		</main>
		<footer>
			<span>AI 语音实验 / ASR · Agent · TTS</span
			><span>识别、分析和合成使用云端 API，会产生调用费用。</span>
		</footer>
	</div>
</template>
