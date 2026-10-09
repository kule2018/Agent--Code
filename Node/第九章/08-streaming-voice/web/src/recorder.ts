/** 采集 16kHz 单声道音频；结束时发送最后不足 100ms 的音频，再关闭麦克风。 */
export class Microphone {
  private context?: AudioContext
  private stream?: MediaStream
  private node?: AudioWorkletNode
  private source?: MediaStreamAudioSourceNode
  private silent?: GainNode
  private disposed = false
  private onFlushed?: () => void
  constructor(private onChunk: (base64: string, level: number) => void) {}
  async prepare() {
    this.context = new AudioContext({ sampleRate: 16000 })
    await this.context.resume()
    if (this.disposed) return
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    if (this.disposed) { this.stream.getTracks().forEach(track => track.stop()); return }
    if (this.context.sampleRate !== 16000) throw new Error('浏览器不支持本例的 16kHz 采集，请使用新版 Chrome / Edge')
    await this.context.audioWorklet.addModule('/pcm-worklet.js')
  }
  start() {
    if (this.disposed || !this.context || !this.stream) return
    this.node = new AudioWorkletNode(this.context, 'pcm-capture')
    this.node.port.onmessage = ({ data }) => {
      if (data.flushed) { this.onFlushed?.(); return }
      if (this.disposed) return
      const bytes = new Uint8Array(data.buffer)
      this.onChunk(btoa(String.fromCharCode(...bytes)), data.level)
    }
    this.source = this.context.createMediaStreamSource(this.stream)
    this.silent = this.context.createGain()
    this.silent.gain.value = 0
    this.source.connect(this.node).connect(this.silent).connect(this.context.destination)
  }
  async stop(discard = false) {
    if (this.disposed) return
    if (!discard && this.node) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 200)
        this.onFlushed = () => { clearTimeout(timer); resolve() }
        this.node!.port.postMessage('flush')
      })
    }
    this.disposed = true
    this.source?.disconnect()
    this.node?.disconnect()
    this.node?.port.close()
    this.silent?.disconnect()
    this.stream?.getTracks().forEach(track => track.stop())
    if (this.context?.state !== 'closed') await this.context?.close()
  }
}
