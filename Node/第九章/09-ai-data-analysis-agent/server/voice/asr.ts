import WebSocket from 'ws'
import { eventId } from './turn.js'

/** 从 07 已使用的百炼兼容地址取得同地域 WebSocket 地址；密钥始终留在服务端。 */
export function asrConfig(env = process.env) {
	if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL)
		throw new Error('请配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL')
	const base = new URL(env.DASHSCOPE_BASE_URL)
	if (
		base.protocol !== 'https:' ||
		base.username ||
		base.password ||
		base.port ||
		base.search ||
		base.hash ||
		base.pathname.replace(/\/$/, '') !== '/compatible-mode/v1' ||
		!/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/.test(
			base.hostname
		)
	) {
		throw new Error('请填写百炼北京或新加坡地域的真实兼容接口地址')
	}
	return {
		key: env.DASHSCOPE_API_KEY,
		url: `wss://${base.host}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime`
	}
}

export type Recognition = {
	append(audio: string): void
	finish(): void
	done: Promise<void>
}

/** 把 PCM 音频块交给实时 ASR，并分开回传预览文本和最终文本。 */
export function openRecognition(
	signal: AbortSignal,
	emit: (event: string, data?: Record<string, unknown>) => void,
	config = asrConfig()
): Recognition {
	// 如果当前任务已经取消，则不再创建识别连接。
	signal.throwIfAborted()

	// 连接实时 ASR 服务，并携带鉴权信息及 WebSocket 安全限制。
	const socket = new WebSocket(config.url, {
		headers: {
			Authorization: `Bearer ${config.key}`,
			'OpenAI-Beta': 'realtime=v1'
		},
		handshakeTimeout: 10000,
		maxPayload: 256 * 1024
	})

	// 记录识别会话状态，避免重复结束或在错误阶段发送音频。
	let ready = false
	let ending = false
	let settled = false
	let bytes = 0

	// 按句子 ID 保存识别文本，区分临时结果与最终确认的结果。
	const items = new Map<string, { text: string; final: boolean }>()

	// 拼接当前所有句子的识别内容，供页面实时预览。
	const preview = () => [...items.values()].map((item) => item.text).join('')

	// done 表示整个识别任务结束，供上层调用者等待。
	let resolve!: () => void
	let reject!: (error: Error) => void
	const done = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})

	// 统一发送 ASR 协议事件，为每次请求生成唯一事件 ID。
	const send = (type: string, body: object = {}) =>
		socket.send(JSON.stringify({ event_id: eventId(), type, ...body }))

	// 统一结束识别任务：清理资源、关闭连接，并完成或拒绝 Promise。
	const settle = (error?: Error) => {
		if (settled) return
		settled = true

		clearTimeout(timer)
		signal.removeEventListener('abort', abort)

		// 连接尚未建立时直接终止，已建立时正常关闭。
		if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
		else if (socket.readyState === WebSocket.OPEN) socket.close()

		error ? reject(error) : resolve()
	}

	// 上层取消当前轮次时，同步终止语音识别。
	const abort = () => settle(signal.reason)

	// 最长等待 45 秒，避免识别服务无响应导致任务一直挂起。
	const timer = setTimeout(
		() => settle(new Error('识别超时，请重新录音')),
		45000
	)
	signal.addEventListener('abort', abort, { once: true })

	// WebSocket 建立后配置识别参数，开启服务端语音活动检测（VAD）。
	socket.on('open', () =>
		send('session.update', {
			session: {
				// 输入音频使用 16kHz PCM 格式。
				input_audio_format: 'pcm',
				sample_rate: 16000,

				// 指定识别语言为中文。
				input_audio_transcription: { language: 'zh' },

				// 由服务端检测语音边界，静音 600ms 后判断当前语音片段结束。
				turn_detection: {
					type: 'server_vad',
					threshold: 0,
					silence_duration_ms: 600
				}
			}
		})
	)

	// 处理 ASR 服务持续返回的事件，包括临时文本、最终文本和错误。
	socket.on('message', (raw) => {
		if (settled) return

		try {
			const event = JSON.parse(raw.toString())

			// 服务端确认配置完成，通知客户端可以开始发送音频。
			if (event.type === 'session.updated' && !ready) {
				ready = true
				emit('asr.ready')
			}

			// 服务端创建新的语音句子，为其初始化识别结果。
			if (
				event.type === 'conversation.item.created' &&
				event.item?.id &&
				!items.has(event.item.id)
			) {
				items.set(event.item.id, { text: '', final: false })
			}

			// 收到实时识别文本，更新对应句子的预览内容。
			if (event.type === 'conversation.item.input_audio_transcription.text') {
				if (!event.item_id) throw new Error('识别结果缺少句子编号')

				// 已经确认的句子不再被临时识别结果覆盖。
				if (!items.get(event.item_id)?.final) {
					items.set(event.item_id, {
						text: (event.text || '') + (event.stash || ''),
						final: false
					})

					// 将当前文本发送给客户端，实现边说边出字。
					emit('asr.partial', { text: preview() })
				}
			}

			// 当前句子识别完成，用最终文本替换之前的临时文本。
			if (
				event.type === 'conversation.item.input_audio_transcription.completed'
			) {
				if (!event.item_id) throw new Error('识别结果缺少句子编号')

				items.set(event.item_id, {
					text: String(event.transcript || '').trim(),
					final: true
				})

				// 更新页面预览，但此时整个录音可能尚未结束。
				emit('asr.partial', { text: preview() })
			}

			// 识别服务返回错误时，交由统一结束逻辑处理。
			if (
				event.type === 'conversation.item.input_audio_transcription.failed' ||
				event.type === 'error'
			) {
				throw new Error(event.error?.message || 'ASR 服务返回错误')
			}

			// 限制句子数量和识别文本长度，避免单次任务消耗过多资源。
			if (items.size > 100 || preview().length > 2000) {
				throw new Error('识别内容过长，请缩短问题')
			}

			// 整个识别会话结束后，检查所有非空句子是否已完成识别。
			if (event.type === 'session.finished') {
				const text = preview().trim()

				if (
					!text ||
					[...items.values()].some((item) => item.text && !item.final)
				) {
					throw new Error('未收到完整识别结果，请重新录音')
				}

				// 只有整个会话成功结束，才返回最终识别文本。
				emit('asr.final', { text })
				settle()
			}
		} catch (error) {
			// 解析或处理事件失败时，终止本次识别。
			settle(error as Error)
		}
	})

	// 处理底层连接错误和意外断开。
	socket.on('error', (error) => settle(error))
	socket.on('close', () => {
		if (!settled) {
			settle(new Error('识别连接提前关闭，请重新录音'))
		}
	})

	// 向上层提供音频追加、录音结束以及任务完成状态。
	return {
		done,

		/** 接收浏览器上传的 Base64 PCM 音频块，并实时转发给 ASR。 */
		append(audio) {
			// 只有识别服务准备就绪且会话尚未结束，才能继续发送音频。
			if (!ready || ending || settled) {
				throw new Error('当前识别会话不能接收音频')
			}

			// 校验 Base64 格式和单个音频块的大小。
			if (
				typeof audio !== 'string' ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(audio) ||
				audio.length > 24000
			) {
				throw new Error('音频块格式错误')
			}

			// 解码音频块，并累计本次录音实际接收的字节数。
			const chunk = Buffer.from(audio, 'base64')
			bytes += chunk.length

			// 16 位 PCM 每个采样占 2 字节，同时限制累计音频数据量。
			if (chunk.length % 2 || bytes > 16000 * 2 * 31) {
				throw new Error('录音格式错误或超过 30 秒')
			}

			// WebSocket 发送缓冲区积压过多时停止上传，避免持续堆积。
			if (socket.bufferedAmount > 128000) {
				throw new Error('网络发送过慢，请重新录音')
			}

			// 将当前音频块发送给 ASR，服务端可以边接收边识别。
			send('input_audio_buffer.append', { audio })
		},

		/** 用户停止录音，通知 ASR 服务结束当前识别会话。 */
		finish() {
			// 防止重复发送结束请求。
			if (ending || settled) return

			// 确保服务已经准备就绪，且上传的音频达到最低长度。
			if (!ready || bytes < 3200) {
				throw new Error('录音过短，请至少说一句完整的问题')
			}

			ending = true

			// VAD 模式由服务端提交各句；用户结束整段录音时只发送 session.finish。
			send('session.finish')
		}
	}
}
