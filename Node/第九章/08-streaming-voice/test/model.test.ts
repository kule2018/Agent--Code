import test from 'node:test'
import assert from 'node:assert/strict'
import { AnalysisModel } from '../server/model.js'

test('模型 SQL 使用 JSON 完整决策，结果解释读取真正的 SSE 增量并传递取消信号', async t => {
  const requests: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    const body = JSON.parse(options.body); requests.push(body)
    assert.ok(options.signal)
    if (!body.stream) {
      assert.equal(body.response_format.type, 'json_object')
      assert.match(body.messages[0].content, /JSON/)
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ action: 'query', sql: 'SELECT 1', metric: '测试', scope: '测试' }) } }] })
    }
    assert.equal(body.response_format, undefined)
    const events = [
      { choices: [{ delta: { content: '华东' }, finish_reason: null }] },
      { choices: [{ delta: { content: '1599元。' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ]
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const model = new AnalysisModel({ DEEPSEEK_API_KEY: 'test-only-key' })
  const signal = new AbortController().signal
  const decision = await model.decide('问题', {}, signal)
  assert.equal(decision.action, 'query')
  const parts: string[] = []
  for await (const text of model.explain('问题', {}, decision, { rows: [] }, signal)) parts.push(text)
  assert.deepEqual(parts, ['华东', '1599元。'])
  assert.equal(requests.length, 2)
})

test('取消以前不发出模型请求', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('不应调用') })
  const model = new AnalysisModel({ DEEPSEEK_API_KEY: 'test-only-key' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(model.decide('问题', {}, controller.signal))
  assert.equal(calls, 0)
})
