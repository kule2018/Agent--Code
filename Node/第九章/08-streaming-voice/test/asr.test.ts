import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'
import { openRecognition } from '../server/asr.js'

test('真实 WebSocket 协议：先配置，再发送音频，预览和最终文本分开，结束后关闭', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  const received: any[] = [], events: any[] = []
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); received.push(message)
    if (message.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }))
    if (message.type === 'input_audio_buffer.append') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', item_id: 'first', text: '九月', stash: '华东' }))
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'first', transcript: '九月华东' }))
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.text', item_id: 'second', text: '销售', stash: '额' }))
    }
    if (message.type === 'session.finish') {
      socket.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'second', transcript: '销售额' }))
      socket.send(JSON.stringify({ type: 'session.finished' }))
    }
  }))
  try {
    const controller = new AbortController()
    let ready!: () => void
    const waitReady = new Promise<void>(resolve => { ready = resolve })
    const recognition = openRecognition(controller.signal, (event, data) => {
      events.push({ event, ...data }); if (event === 'asr.ready') ready()
    }, { url: `ws://127.0.0.1:${(server.address() as any).port}`, key: 'test-key' })
    await waitReady
    recognition.append(Buffer.alloc(3200).toString('base64')); recognition.finish()
    await recognition.done
    assert.equal(received[0].session.sample_rate, 16000)
    assert.equal(received[0].session.turn_detection.type, 'server_vad')
    assert.deepEqual(received.map(message => message.type), ['session.update', 'input_audio_buffer.append', 'session.finish'])
    assert.deepEqual(events.map(event => [event.event, event.text]), [
      ['asr.ready', undefined], ['asr.partial', '九月华东'], ['asr.partial', '九月华东'],
      ['asr.partial', '九月华东销售额'], ['asr.partial', '九月华东销售额'], ['asr.final', '九月华东销售额']
    ])
  } finally {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('取消实时识别会关闭上游 WebSocket', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(server, 'listening')
  try {
    const controller = new AbortController()
    const connecting = once(server, 'connection')
    const recognition = openRecognition(controller.signal, () => {}, { url: `ws://127.0.0.1:${(server.address() as any).port}`, key: 'test-key' })
    const [client] = await connecting
    const closed = once(client, 'close')
    controller.abort(new DOMException('用户取消', 'AbortError'))
    await assert.rejects(recognition.done, /用户取消/)
    await closed
  } finally {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
