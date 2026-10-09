export interface AudioSegment { turnId: string; seq: number; text: string; audioUrl: string }

/** 按收到的句子顺序播放；打断时同时清空未播放队列和正在播放的音频。 */
export class PlaybackQueue {
  private items: AudioSegment[] = []
  private current?: AudioSegment
  private turnId = ''
  private lastSequence = -1
  constructor(private audio: HTMLAudioElement, private changed: (text: string) => void,
    private blocked: () => void, private played: () => void) {
    audio.onended = () => { this.current = undefined; this.next() }
    audio.onerror = () => { this.changed('当前音频加载失败'); this.current = undefined; this.next() }
    audio.onplaying = () => this.played()
  }
  begin(turnId: string) { this.stop(); this.turnId = turnId }
  push(segment: AudioSegment) {
    if (segment.turnId !== this.turnId || segment.seq <= this.lastSequence) return
    this.lastSequence = segment.seq
    this.items.push(segment)
    if (!this.current) this.next()
  }
  private next() {
    this.current = this.items.shift()
    this.changed(this.current?.text || '')
    if (!this.current) return
    this.audio.src = this.current.audioUrl
    this.resume()
  }
  resume() {
    const id = this.turnId
    void this.audio.play().catch(() => { if (id === this.turnId && this.current) this.blocked() })
  }
  stop() {
    this.turnId = ''
    this.items = []
    this.current = undefined
    this.lastSequence = -1
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
    this.changed('')
  }
}
