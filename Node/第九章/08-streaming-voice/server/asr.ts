import WebSocket from 'ws'
import { eventId } from './turn.js'

/** 从 07 已使用的百炼兼容地址取得同地域 WebSocket 地址；密钥始终留在服务端。 */
export function asrConfig(env = process.env) {
  if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL) throw new Error('请配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL')
  const base = new URL(env.DASHSCOPE_BASE_URL)
  if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash ||
      base.pathname.replace(/\/$/, '') !== '/compatible-mode/v1' ||
      !/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/.test(base.hostname)) {
    throw new Error('请填写百炼北京或新加坡地域的真实兼容接口地址')
  }
  return { key: env.DASHSCOPE_API_KEY,
    url: `wss://${base.host}/api-ws/v1/realtime?model=qwen3-asr-flash-realtime` }
}

export type Recognition = { append(audio: string): void; finish(): void; done: Promise<void> }

/** 把 PCM 音频块交给实时 ASR，并分开回传预览文本和最终文本。 */
export function openRecognition(signal: AbortSignal, emit: (event: string, data?: Record<string, unknown>) => void,
  config = asrConfig()): Recognition {
  signal.throwIfAborted()
  const socket = new WebSocket(config.url, { headers: { Authorization: `Bearer ${config.key}`, 'OpenAI-Beta': 'realtime=v1' }, handshakeTimeout: 10000, maxPayload: 256 * 1024 })
  let ready = false
  let ending = false
  let settled = false
  let bytes = 0
  const items = new Map<string, { text: string; final: boolean }>()
  const preview = () => [...items.values()].map(item => item.text).join('')
  let resolve!: () => void
  let reject!: (error: Error) => void
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const send = (type: string, body: object = {}) => socket.send(JSON.stringify({ event_id: eventId(), type, ...body }))
  const settle = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    else if (socket.readyState === WebSocket.OPEN) socket.close()
    error ? reject(error) : resolve()
  }
  const abort = () => settle(signal.reason)
  const timer = setTimeout(() => settle(new Error('识别超时，请重新录音')), 45000)
  signal.addEventListener('abort', abort, { once: true })
  socket.on('open', () => send('session.update', { session: {
    input_audio_format: 'pcm', sample_rate: 16000,
    input_audio_transcription: { language: 'zh' },
    turn_detection: { type: 'server_vad', threshold: 0, silence_duration_ms: 600 }
  } }))
  socket.on('message', raw => {
    if (settled) return
    try {
      const event = JSON.parse(raw.toString())
      if (event.type === 'session.updated' && !ready) { ready = true; emit('asr.ready') }
      if (event.type === 'conversation.item.created' && event.item?.id && !items.has(event.item.id)) {
        items.set(event.item.id, { text: '', final: false })
      }
      if (event.type === 'conversation.item.input_audio_transcription.text') {
        if (!event.item_id) throw new Error('识别结果缺少句子编号')
        if (!items.get(event.item_id)?.final) {
          items.set(event.item_id, { text: (event.text || '') + (event.stash || ''), final: false })
          emit('asr.partial', { text: preview() })
        }
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        if (!event.item_id) throw new Error('识别结果缺少句子编号')
        items.set(event.item_id, { text: String(event.transcript || '').trim(), final: true })
        emit('asr.partial', { text: preview() })
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed' || event.type === 'error') {
        throw new Error(event.error?.message || 'ASR 服务返回错误')
      }
      if (items.size > 100 || preview().length > 2000) throw new Error('识别内容过长，请缩短问题')
      if (event.type === 'session.finished') {
        const text = preview().trim()
        if (!text || [...items.values()].some(item => item.text && !item.final)) {
          throw new Error('未收到完整识别结果，请重新录音')
        }
        emit('asr.final', { text })
        settle()
      }
    } catch (error) { settle(error as Error) }
  })
  socket.on('error', error => settle(error))
  socket.on('close', () => { if (!settled) settle(new Error('识别连接提前关闭，请重新录音')) })
  return {
    done,
    append(audio) {
      if (!ready || ending || settled) throw new Error('当前识别会话不能接收音频')
      if (typeof audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) || audio.length > 24000) throw new Error('音频块格式错误')
      const chunk = Buffer.from(audio, 'base64')
      bytes += chunk.length
      if (chunk.length % 2 || bytes > 16000 * 2 * 31) throw new Error('录音格式错误或超过 30 秒')
      if (socket.bufferedAmount > 128000) throw new Error('网络发送过慢，请重新录音')
      send('input_audio_buffer.append', { audio })
    },
    finish() {
      if (ending || settled) return
      if (!ready || bytes < 3200) throw new Error('录音过短，请至少说一句完整的问题')
      ending = true
      // VAD 模式由服务端提交各句；用户结束整段录音时只发送 session.finish。
      send('session.finish')
    }
  }
}
