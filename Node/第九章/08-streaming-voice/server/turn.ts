import { randomUUID } from 'node:crypto'
import type { Packet } from '../shared/protocol.js'

/** 一轮请求的取消信号与事件出口；旧轮次不能继续向页面发送结果。 */
export class Turn {
  readonly controller = new AbortController()
  readonly started = performance.now()
  constructor(readonly id: string, private deliver: (packet: Packet) => void) {}
  get signal() { return this.controller.signal }
  send(event: string, data: Record<string, unknown> = {}) {
    if (!this.signal.aborted) this.deliver({ event, data: { ...data, turnId: this.id } })
  }
  cancel() { this.controller.abort(new DOMException('本轮已停止', 'AbortError')) }
}

/** 每个浏览器连接独立管理当前轮次；替换以前先取消上一轮。 */
export class TurnSlot {
  current?: Turn
  begin(id: unknown, deliver: (packet: Packet) => void) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('turnId 无效')
    if (this.current?.id === id) throw new Error('每轮需要使用新的 turnId')
    this.current?.cancel()
    const turn = new Turn(id, packet => { if (this.current === turn) deliver(packet) })
    this.current = turn
    return turn
  }
  cancel(id?: string) { if (!id || this.current?.id === id) this.current?.cancel() }
}
export const eventId = () => randomUUID()
