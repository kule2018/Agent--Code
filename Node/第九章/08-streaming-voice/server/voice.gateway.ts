import { Inject } from '@nestjs/common'
import { WebSocketGateway, SubscribeMessage, ConnectedSocket, MessageBody } from '@nestjs/websockets'
import WebSocket from 'ws'
import { z } from 'zod'
import { TurnSlot } from './turn.js'
import { openRecognition, type Recognition } from './asr.js'
import { VoiceService } from './voice.service.js'

const askSchema = z.object({ turnId: z.string().min(1).max(80), question: z.string().trim().min(1).max(2000), mode: z.enum(['stream', 'buffered']) })
type Session = { slot: TurnSlot; asr?: Recognition }

/** 浏览器的录音、提问和取消入口；连接断开也会取消当前轮次。 */
@WebSocketGateway({ path: '/voice', maxPayload: 32 * 1024 })
export class VoiceGateway {
  private sessions = new Map<WebSocket, Session>()
  constructor(@Inject(VoiceService) private readonly service: VoiceService) {}
  handleConnection(socket: WebSocket) { this.sessions.set(socket, { slot: new TurnSlot() }) }
  handleDisconnect(socket: WebSocket) {
    this.sessions.get(socket)?.slot.cancel()
    this.sessions.delete(socket)
  }
  private begin(socket: WebSocket, id: unknown) {
    const session = this.sessions.get(socket)!
    session.asr = undefined
    const turn = session.slot.begin(id, packet => {
      if (socket.readyState !== WebSocket.OPEN) return
      if (socket.bufferedAmount > 512000) { session.slot.cancel(); socket.close(); return }
      socket.send(JSON.stringify(packet))
    })
    return { session, turn }
  }
  @SubscribeMessage('ask')
  async ask(@ConnectedSocket() socket: WebSocket, @MessageBody() data: unknown) {
    const parsed = askSchema.safeParse(data)
    if (!parsed.success) { socket.send(JSON.stringify({ event: 'error', data: { turnId: (data as any)?.turnId, text: '问题或模式无效' } })); return }
    const { turn } = this.begin(socket, parsed.data.turnId)
    const timer = setTimeout(() => { turn.send('error', { text: '本轮超过 120 秒，已停止' }); turn.cancel() }, 120000)
    try { await this.service.answer(turn, parsed.data.question, parsed.data.mode) }
    catch (error) { turn.send('error', { text: (error as Error).message }); turn.cancel() }
    finally { clearTimeout(timer) }
  }
  @SubscribeMessage('listen')
  async listen(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) {
    const { session, turn } = this.begin(socket, data?.turnId)
    try {
      session.asr = openRecognition(turn.signal, (event, body) => turn.send(event, body))
      await session.asr.done
    } catch (error) { turn.send('error', { text: (error as Error).message }); turn.cancel() }
  }
  @SubscribeMessage('audio')
  audio(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string; audio: string }) {
    const session = this.sessions.get(socket)!
    if (session.slot.current?.id !== data?.turnId || session.slot.current.signal.aborted) return
    try { session.asr?.append(data.audio) }
    catch (error) { session.slot.current.send('error', { text: (error as Error).message }); session.slot.cancel() }
  }
  @SubscribeMessage('finish')
  finish(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) {
    const session = this.sessions.get(socket)!
    if (session.slot.current?.id !== data?.turnId) return
    try { session.asr?.finish() }
    catch (error) { session.slot.current.send('error', { text: (error as Error).message }); session.slot.cancel() }
  }
  @SubscribeMessage('cancel')
  cancel(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) {
    if (typeof data?.turnId === 'string') this.sessions.get(socket)?.slot.cancel(data.turnId)
  }
}
