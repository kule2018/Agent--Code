import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import {
  DashboardSchema, loadImage, buildRequest, parseReading,
  prepareAgentInput, inspectDashboard
} from './image-understanding.js'

// 以下是单元测试构造的数据，不是视觉模型的实测输出。
const reading = {
  title: '销售经营看板',
  period: '2026-09-01 至 2026-09-30',
  metric: '销售额',
  value: '128.60',
  unit: '万元',
  scope: '全部区域，已支付订单实付金额，未扣除退款',
  evidence: ['统计周期：2026-09-01 至 2026-09-30', '销售额', '128.60', '万元', '未扣除退款'],
  uncertainties: []
}
const samplePath = fileURLToPath(new URL('./samples/dashboard-clear.png', import.meta.url))
const completion = (data, reason = 'stop') => ({
  choices: [{ finish_reason: reason, message: { role: 'assistant', content: JSON.stringify(data) } }]
})

test('本地 PNG 进入 image_url，问题与图片在同一条消息中', async () => {
  const image = await loadImage(samplePath)
  const request = buildRequest(image, 'qwen3-vl-flash')
  assert.equal(image.mimeType, 'image/png')
  assert.match(image.sha256, /^[a-f0-9]{64}$/)
  assert.equal(request.enable_thinking, false)
  assert.deepEqual(request.response_format, { type: 'json_object' })
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].type, 'text')
  assert.match(request.messages[0].content[0].text, /JSON/)
  assert.match(request.messages[0].content[1].image_url.url, /^data:image\/png;base64,/)
  assert.ok(!JSON.stringify(request).includes(samplePath))
})

test('信息完整只标为 extracted，不标为已经核验', () => {
  const result = prepareAgentInput(parseReading(completion(reading)))
  assert.equal(result.status, 'extracted')
  assert.deepEqual(result.confirmationQuestions, [])
  assert.equal(result.reading.value, '128.60')
})

test('必需字段为 null，即使模型没有提示，也进入待确认分支', () => {
  const result = prepareAgentInput({ ...reading, period: null, value: null, unit: null })
  assert.equal(result.status, 'needs_confirmation')
  assert.equal(result.confirmationQuestions.length, 3)
  assert.match(result.confirmationQuestions.join(' '), /统计时间/)
})

test('模型提示不确定性，仍然需要用户确认', () => {
  const result = prepareAgentInput({ ...reading, uncertainties: ['图中两处统计口径不一致'] })
  assert.equal(result.status, 'needs_confirmation')
})

test('没有图中文字摘录时提示核对', () => {
  assert.equal(prepareAgentInput({ ...reading, evidence: [] }).status, 'needs_confirmation')
})

test('空白字段、丢失字段和错误类型无法通过 Schema', () => {
  assert.equal(DashboardSchema.safeParse({ ...reading, unit: ' ' }).success, false)
  assert.throws(() => parseReading(completion({ ...reading, value: 128.6 })), /字段不符合/)
  const { period, ...incomplete } = reading
  assert.throws(() => parseReading(completion(incomplete)), /字段不符合/)
})

test('拒绝 JSON 语法错误、截断和没有正文的响应', () => {
  assert.throws(() => parseReading({ choices: [{ finish_reason: 'stop', message: { content: '```json {} ```' } }] }), /有效 JSON/)
  assert.throws(() => parseReading(completion(reading, 'length')), /完整正文/)
  assert.throws(() => parseReading({ choices: [] }), /完整正文/)
})

test('拒绝文本伪装图片、空文件和超过案例大小上限的文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'image-lesson-'))
  try {
    const file = join(dir, 'fake.png')
    await writeFile(file, 'not an image')
    await assert.rejects(loadImage(file), /文件头/)
    await writeFile(file, '')
    await assert.rejects(loadImage(file), /非空/)
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1))
    await assert.rejects(loadImage(file), /5 MiB/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('真实 SDK 对接本地模拟 HTTP：验证请求序列化与响应解析，不验证视觉能力', async () => {
  let received
  let receivedUrl
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = JSON.parse(Buffer.concat(chunks).toString())
    receivedUrl = req.url
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ...completion(reading), usage: { total_tokens: 123 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const client = new OpenAI({
      apiKey: 'local-test-only',
      baseURL: `http://127.0.0.1:${server.address().port}/compatible-mode/v1`,
      maxRetries: 0
    })
    const result = await inspectDashboard(client, await loadImage(samplePath), 'qwen3-vl-flash')
    assert.equal(receivedUrl, '/compatible-mode/v1/chat/completions')
    assert.equal(received.enable_thinking, false)
    assert.equal(received.model, 'qwen3-vl-flash')
    assert.equal(received.messages[0].content[1].type, 'image_url')
    assert.equal(result.status, 'extracted')
    assert.equal(result.usage.total_tokens, 123)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
