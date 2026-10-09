import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { PlaybackQueue } from '../web/src/playback.js'
import { Microphone } from '../web/src/recorder.js'

/** 浏览器替身只验证队列与设备生命周期，不播放真实音频或访问麦克风。 */
class FakeAudio {
  src = ''
  onended?: () => void
  onerror?: () => void
  onplaying?: () => void
  played: string[] = []
  pauses = 0
  loads = 0
  playImpl: () => Promise<void> = async () => {}
  play() { this.played.push(this.src); return this.playImpl() }
  pause() { this.pauses++ }
  load() { this.loads++ }
  removeAttribute(name: string) { if (name === 'src') this.src = '' }
}

function playback() {
  const audio = new FakeAudio(), changed: string[] = []
  let blocked = 0, played = 0
  const queue = new PlaybackQueue(audio as unknown as HTMLAudioElement,
    text => changed.push(text), () => blocked++, () => played++)
  const segment = (turnId: string, seq: number) => ({ turnId, seq, text: `句${seq}`, audioUrl: `https://example.test/${turnId}-${seq}.wav` })
  return { audio, changed, queue, segment, blocked: () => blocked, played: () => played }
}

test('播放按序进行，忽略旧轮次、重复段和倒序段，允许失败后序号留空', () => {
  const f = playback()
  f.queue.begin('new')
  f.queue.push(f.segment('old', 0))
  f.queue.push(f.segment('new', 0))
  f.queue.push(f.segment('new', 0))
  f.queue.push(f.segment('new', 2))
  f.queue.push(f.segment('new', 1))
  assert.deepEqual(f.audio.played, ['https://example.test/new-0.wav'])
  f.audio.onended!()
  assert.deepEqual(f.audio.played, ['https://example.test/new-0.wav', 'https://example.test/new-2.wav'])
  f.audio.onplaying!()
  assert.equal(f.played(), 1)
  f.audio.onended!()
  assert.equal(f.changed.at(-1), '')
})

test('打断清空播放和队列，迟到的自动播放拒绝不能影响新轮次', async () => {
  const f = playback()
  let reject!: (error: Error) => void
  f.audio.playImpl = () => new Promise((_resolve, fail) => { reject = fail })
  f.queue.begin('old')
  f.queue.push(f.segment('old', 0))
  f.queue.push(f.segment('old', 1))
  f.queue.stop()
  f.queue.begin('new')
  f.audio.playImpl = async () => {}
  f.queue.push(f.segment('new', 0))
  reject(new Error('old blocked'))
  await Promise.resolve()
  assert.equal(f.blocked(), 0)
  f.audio.onended!()
  assert.deepEqual(f.audio.played, ['https://example.test/old-0.wav', 'https://example.test/new-0.wav'])
  assert.ok(f.audio.pauses >= 3)
  assert.ok(f.audio.loads >= 3)
})

test('当前播放被浏览器拦截时提示并允许手动继续，加载失败继续下一段', async () => {
  const f = playback()
  f.queue.begin('one')
  f.audio.playImpl = async () => { throw new Error('autoplay blocked') }
  f.queue.push(f.segment('one', 0))
  f.queue.push(f.segment('one', 1))
  await Promise.resolve()
  assert.equal(f.blocked(), 1)
  f.audio.playImpl = async () => {}
  f.queue.resume()
  f.audio.onerror!()
  assert.ok(f.changed.includes('当前音频加载失败'))
  assert.equal(f.audio.played.at(-1), 'https://example.test/one-1.wav')
})

function pcm() {
  const messages: any[] = []
  let Processor: any
  class Worklet {
    port = { onmessage: undefined, postMessage: (message: any) => messages.push(message) }
  }
  const context = vm.createContext({ AudioWorkletProcessor: Worklet,
    registerProcessor: (name: string, Type: any) => { assert.equal(name, 'pcm-capture'); Processor = Type } })
  vm.runInContext(readFileSync(new URL('../web/public/pcm-worklet.js', import.meta.url), 'utf8'), context)
  return { processor: new Processor(), messages }
}

test('PCM 每 1600 采样发送一次，正确限幅、PCM16 小端和 RMS 音量', () => {
  const f = pcm()
  const values = [-2, -1, -0.5, 0, 0.5, 1, 2, ...Array(1593).fill(0)]
  assert.equal(f.processor.process([[values]]), true)
  assert.equal(f.messages.length, 1)
  const view = new DataView(f.messages[0].buffer)
  assert.equal(view.byteLength, 3200)
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => view.getInt16(i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767])
  assert.equal(f.messages[0].level, Math.sqrt(4.5 / 1600))
})

test('停止录音先发送不足 100ms 的尾块，空尾块只确认 flush', () => {
  const f = pcm()
  f.processor.process([[[0.25, -0.25]]])
  assert.equal(f.messages.length, 0)
  f.processor.port.onmessage({ data: 'flush' })
  assert.equal(f.messages[0].buffer.byteLength, 4)
  assert.equal(f.messages[1].flushed, true)
  f.processor.port.onmessage({ data: 'flush' })
  assert.equal(f.messages.length, 3)
  assert.equal(f.messages[2].flushed, true)
})

/** 安装/恢复浏览器替身，测试不会取得真实设备权限。 */
function microphoneFixture(getUserMedia?: () => Promise<any>) {
  let trackStops = 0, portClosed = 0
  const modules: string[] = [], nodes: any[] = [], contexts: any[] = []
  const stream = { getTracks: () => [{ stop: () => trackStops++ }] }
  const graph = () => ({ connect: (target: any) => target, disconnect: () => {} })
  class Context {
    sampleRate = 16000
    state = 'running'
    destination = {}
    audioWorklet = { addModule: async (path: string) => { modules.push(path) } }
    constructor(public options: any) { contexts.push(this) }
    async resume() {}
    async close() { this.state = 'closed' }
    createMediaStreamSource() { return graph() }
    createGain() { return { ...graph(), gain: { value: 1 } } }
  }
  class Node {
    port = {
      onmessage: undefined as any,
      close: () => { portClosed++ },
      postMessage: (message: string) => {
        assert.equal(message, 'flush')
        this.port.onmessage({ data: { buffer: new Uint8Array([1, 2]).buffer, level: 0.2 } })
        this.port.onmessage({ data: { flushed: true } })
      },
    }
    constructor() { nodes.push(this) }
    connect(target: any) { return target }
    disconnect() {}
  }
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [name, value] of Object.entries({ AudioContext: Context, AudioWorkletNode: Node,
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } } })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  return { stream, modules, nodes, contexts, trackStops: () => trackStops, portClosed: () => portClosed,
    restore() { for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    } } }
}

test('麦克风正常结束发送尾块后关闭，打断丢弃尾块，关闭后忽略迟到数据', async () => {
  const f = microphoneFixture(), chunks: string[] = []
  try {
    const microphone = new Microphone(chunk => chunks.push(chunk))
    await microphone.prepare()
    assert.equal(f.contexts[0].options.sampleRate, 16000)
    assert.deepEqual(f.modules, ['/pcm-worklet.js'])
    microphone.start()
    await microphone.stop()
    assert.deepEqual(chunks, ['AQI='])
    assert.equal(f.trackStops(), 1)
    assert.equal(f.portClosed(), 1)
    assert.equal(f.contexts[0].state, 'closed')
    f.nodes[0].port.onmessage({ data: { buffer: new Uint8Array([3, 4]).buffer, level: 1 } })
    assert.deepEqual(chunks, ['AQI='])
    const interrupted = new Microphone(chunk => chunks.push(chunk))
    await interrupted.prepare()
    interrupted.start()
    await interrupted.stop(true)
    assert.deepEqual(chunks, ['AQI='])
    assert.equal(f.trackStops(), 2)
  } finally { f.restore() }
})

test('申请麦克风权限期间打断，迟到的设备授权也立即关闭', async () => {
  let allow!: (stream: any) => void
  const f = microphoneFixture(() => new Promise(resolve => { allow = resolve }))
  try {
    const microphone = new Microphone(() => assert.fail('不应发送音频'))
    const preparing = microphone.prepare()
    while (!allow) await Promise.resolve()
    await microphone.stop(true)
    allow(f.stream)
    await preparing
    microphone.start()
    assert.equal(f.trackStops(), 1)
    assert.equal(f.nodes.length, 0)
    assert.equal(f.contexts[0].state, 'closed')
  } finally { f.restore() }
})
