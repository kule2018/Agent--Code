import test from 'node:test'
import assert from 'node:assert/strict'
import { TurnSlot, Turn } from '../server/turn.js'
import { SentenceBuffer } from '../server/sentences.js'
import { VoiceService } from '../server/voice.service.js'
import { PlaybackQueue } from '../web/src/playback.js'
import { asrConfig } from '../server/asr.js'
import { questionExample, type Packet } from '../shared/protocol.js'

const decision = { action: 'query', sql: 'SELECT 1', metric: '未扣退款销售额', scope: '九月已导入记录' }
const result = { rows: [{ region: '华东', sales_amount: '1599.00' }] }
const text = ['仅按九月已导入记录。', '华东未扣退款销售额为1599.00元。']
function fixture(chunks = text) {
  return {
    load: async () => ({ databasePath: '/unused', context: { rules: [] } }),
    model: () => ({ decide: async () => decision, async *explain() { yield* chunks } }),
    execute: async () => result,
    speak: async (text: string) => 'https://example.test/' + encodeURIComponent(text)
  } as any
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('句子可以跨 Token 块，金额的小数点不被切开，最后无标点内容也能送出', () => {
  const buffer = new SentenceBuffer()
  assert.deepEqual(buffer.push('华东1599.'), [])
  assert.deepEqual(buffer.push('00元。华南'), ['华东1599.00元。'])
  assert.deepEqual(buffer.push('798元。\n'), ['华南798元。'])
  assert.deepEqual(buffer.push('范围仅含导入记录'), [])
  assert.deepEqual(buffer.flush(), ['范围仅含导入记录'])
  assert.deepEqual(buffer.flush(), [])
})

test('轮次替换和取消以后，迟到结果不再向浏览器发送', () => {
  const slot = new TurnSlot(), packets: Packet[] = []
  const first = slot.begin('first', packet => packets.push(packet))
  first.send('answer.delta')
  const next = slot.begin('next', packet => packets.push(packet))
  assert.equal(first.signal.aborted, true)
  first.send('audio.segment')
  slot.cancel('first')
  assert.equal(next.signal.aborted, false)
  next.send('answer.delta')
  slot.cancel('next')
  next.send('audio.segment')
  assert.deepEqual(packets.map(packet => packet.data.turnId), ['first', 'next'])
  assert.throws(() => slot.begin('.. /invalid', () => {}))
})

test('第一句在模型全部结束以前进入合成，两句音频保持顺序', async () => {
  const events: Packet[] = [], spoken: string[] = []
  let continueModel!: () => void
  const gate = new Promise<void>(resolve => { continueModel = resolve })
  const deps = fixture()
  deps.model = () => ({ decide: async () => decision, async *explain() { yield text[0]; await gate; yield text[1] } })
  deps.speak = async (value: string) => { spoken.push(value); return 'https://example.test/a.wav' }
  const task = new VoiceService().answer(new Turn('one', packet => events.push(packet)), questionExample, 'stream', deps)
  await tick()
  assert.deepEqual(spoken, [text[0]])
  assert.equal(events.some(e => e.event === 'done'), false)
  continueModel()
  await task
  assert.deepEqual(spoken, text)
  assert.deepEqual(events.filter(e => e.event === 'audio.segment').map(e => e.data.seq), [0, 1])
  assert.equal(events.at(-1)?.event, 'done')
})

test('完整后返回模式等待全文，只调用一次 TTS', async () => {
  const events: Packet[] = [], spoken: string[] = []
  const deps = fixture()
  deps.speak = async (value: string) => { spoken.push(value); return 'https://example.test/a.wav' }
  await new VoiceService().answer(new Turn('one', p => events.push(p)), questionExample, 'buffered', deps)
  assert.deepEqual(spoken, [text.join('')])
  assert.equal(events.filter(e => e.event === 'answer.delta').length, 1)
})

test('容器结果迟到时停止后续模型解释和合成', async () => {
  const events: Packet[] = []
  let complete!: (value: unknown) => void
  const deps = fixture()
  deps.execute = () => new Promise(resolve => { complete = resolve })
  const turn = new Turn('old', p => events.push(p))
  const task = new VoiceService().answer(turn, questionExample, 'stream', deps)
  const rejected = assert.rejects(task, /本轮已停止/)
  await tick()
  turn.cancel()
  complete(result)
  await rejected
  assert.equal(events.some(e => e.event === 'query.result' || e.event === 'answer.delta'), false)
})

test('TTS 忽略取消仍返回时，旧音频也会被丢弃，后续段不再请求', async () => {
  const events: Packet[] = []
  const deps = fixture()
  let release!: () => void, calls = 0
  deps.speak = async () => { calls++; await new Promise<void>(resolve => { release = resolve }); return 'https://example.test/late.wav' }
  const turn = new Turn('old', p => events.push(p))
  const task = new VoiceService().answer(turn, questionExample, 'stream', deps)
  const rejected = assert.rejects(task, /本轮已停止/)
  await tick()
  turn.cancel(); release()
  await rejected
  assert.equal(calls, 1)
  assert.equal(events.some(e => e.event === 'audio.segment' || e.event === 'done'), false)
})

test('合成失败保留文字和真实表格，页面收到明确提示', async () => {
  const events: Packet[] = [], deps = fixture()
  deps.speak = async () => { throw new Error('供应商不可用') }
  await new VoiceService().answer(new Turn('one', p => events.push(p)), questionExample, 'stream', deps)
  assert.ok(events.some(e => e.event === 'query.result'))
  assert.equal(events.filter(e => e.event === 'answer.delta').map(e => e.data.text).join(''), text.join(''))
  assert.equal(events.filter(e => e.event === 'audio.warning').length, 2)
  assert.equal(events.at(-1)?.event, 'done')
})

test('生成中断时标记部分回答，停止后续音频而不冒充成功', async () => {
  const events: Packet[] = [], deps = fixture()
  deps.model = () => ({ decide: async () => decision, async *explain() { yield '仅按'; throw new Error('流断开') } })
  await assert.rejects(new VoiceService().answer(new Turn('one', p => events.push(p)), questionExample, 'stream', deps), /流断开/)
  assert.ok(events.some(e => e.event === 'error'))
  assert.equal(events.some(e => e.event === 'done'), false)
})

class FakeAudio {
  src = ''; plays: string[] = []; pauses = 0
  onended = () => {}; onerror = () => {}; onplaying = () => {}
  async play() { this.plays.push(this.src) }
  pause() { this.pauses++ }
  removeAttribute() { this.src = '' }
  load() {}
}
test('播放队列逐段播放；打断清空剩余段，并拒绝旧轮次和重复段', () => {
  const audio = new FakeAudio()
  const queue = new PlaybackQueue(audio as any, () => {}, () => {}, () => {})
  const segment = (turnId: string, seq: number) => ({ turnId, seq, text: '测试', audioUrl: 'audio-' + seq })
  queue.begin('old')
  queue.push(segment('old', 0)); queue.push(segment('old', 1))
  assert.deepEqual(audio.plays, ['audio-0'])
  audio.onended()
  assert.deepEqual(audio.plays, ['audio-0', 'audio-1'])
  queue.push(segment('old', 2))
  queue.begin('new')
  queue.push(segment('old', 3))
  audio.onended()
  assert.deepEqual(audio.plays, ['audio-0', 'audio-1'])
  queue.push(segment('new', 0)); queue.push(segment('new', 0))
  assert.deepEqual(audio.plays, ['audio-0', 'audio-1', 'audio-0'])
})

test('ASR 使用配置业务空间，拒绝把密钥发送给任意主机', () => {
  const env = { DASHSCOPE_API_KEY: 'test-key', DASHSCOPE_BASE_URL: 'https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }
  assert.equal(asrConfig(env).url, 'wss://test.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime')
  assert.throws(() => asrConfig({ ...env, DASHSCOPE_BASE_URL: 'https://evil.example/compatible-mode/v1' }))
})
