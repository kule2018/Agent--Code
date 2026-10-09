import { WebSocketGateway, SubscribeMessage, ConnectedSocket, MessageBody, type OnGatewayDisconnect } from '@nestjs/websockets'
import WebSocket from 'ws'
import { openRecognition, type Recognition } from './asr.js'

/** 识别连接仅负责转写；用户确认文本后走已有的分析请求。 */
@WebSocketGateway({ path: '/voice' })
export class VoiceGateway implements OnGatewayDisconnect {
  private active = new Map<WebSocket, { id: string; controller: AbortController; recognition: Recognition }>()
  @SubscribeMessage('listen')
  async listen(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) {
    this.handleDisconnect(socket)
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(data.turnId)) return
    const controller = new AbortController()
    const emit = (event: string, details: Record<string, unknown> = {}) => {
      if (!controller.signal.aborted && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, data: { ...details, turnId: data.turnId } }))
    }
    try {
      const recognition = openRecognition(controller.signal, emit)
      this.active.set(socket, { id: data.turnId, controller, recognition })
      await recognition.done
    } catch (error) { emit('error', { message: (error as Error).message }) }
    finally { if (this.active.get(socket)?.controller === controller) this.active.delete(socket) }
  }
  @SubscribeMessage('audio')
  audio(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string; audio: string }) { this.use(socket, data.turnId, r => r.append(data.audio)) }
  @SubscribeMessage('finish')
  finish(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) { this.use(socket, data.turnId, r => r.finish()) }
  @SubscribeMessage('cancel')
  cancel(@ConnectedSocket() socket: WebSocket, @MessageBody() data: { turnId: string }) { if (this.active.get(socket)?.id === data.turnId) this.handleDisconnect(socket) }
  private use(socket: WebSocket, id: string, action: (recognition: Recognition) => void) {
    const active = this.active.get(socket)
    if (!active || active.id !== id) return
    try { action(active.recognition) } catch (error) {
      socket.send(JSON.stringify({ event: 'error', data: { turnId: id, message: (error as Error).message } }))
      this.handleDisconnect(socket)
    }
  }
  handleDisconnect(socket: WebSocket) {
    this.active.get(socket)?.controller.abort(new DOMException('录音已停止', 'AbortError'))
    this.active.delete(socket)
  }
}
