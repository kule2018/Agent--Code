import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { transcribe, synthesize, validateAudio } from '../speech.js'
import { selectSpeechText, analyze } from '../analysis.js'
import { createApp } from '../server.js'

const env = { DASHSCOPE_API_KEY: 'test-only-key', DASHSCOPE_BASE_URL: 'https://test-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(100)])
const audioUrl = 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?Signature=example'
const result = { status: 'answered', answer: '华东 1599 元。', speechText: '华东 1599 元。', rows: [{ region: '华东', sales_amount: '1599.00' }] }

test('ASR 发送音频，不携带文字分析指令，并从响应读取文字', async () => {
  const text = await transcribe(webm, 'audio/webm;codecs=opus', { env, fetchImpl: async (url, options) => {
    assert.equal(url, `${env.DASHSCOPE_BASE_URL}/chat/completions`)
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'qwen3-asr-flash')
    assert.equal(body.stream, false)
    assert.equal(body.messages[0].content[0].input_audio.data, `data:audio/webm;base64,${webm.toString('base64')}`)
    return Response.json({ choices: [{ message: { content: '  九月销售额  ' } }] })
  } })
  assert.equal(text, '九月销售额')
})

test('空录音、超大文件和伪装 MIME 在本地被拒绝', () => {
  assert.throws(() => validateAudio(Buffer.alloc(0), 'audio/webm'), /录音为空/)
  assert.throws(() => validateAudio(Buffer.alloc(2 * 1024 * 1024 + 1), 'audio/webm'), /超过/)
  assert.throws(() => validateAudio(webm, 'audio/ogg'), /格式/)
  assert.equal(validateAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]), 'audio/ogg'), 'audio/ogg')
})

test('ASR 空转写和供应商错误不冒充有效问题', async () => {
  await assert.rejects(transcribe(webm, 'audio/webm', { env, fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }) }), /没有识别到文字/)
  await assert.rejects(transcribe(webm, 'audio/webm', { env, fetchImpl: async () => Response.json({ error: { message: 'Workspace endpoint is invalid.' } }, { status: 400 }) }), /Workspace endpoint/)
})

test('TTS 使用原生合成接口，接收正确回答并返回 HTTPS 临时地址', async () => {
  const url = await synthesize('华东销售额为 1599 元。', { env, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://test-workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    assert.deepEqual(JSON.parse(options.body), { model: 'qwen3-tts-flash', input: { text: '华东销售额为 1599 元。', voice: 'Cherry', language_type: 'Chinese' } })
    return Response.json({ output: { audio: { url: audioUrl.replace('https:', 'http:') } } })
  } })
  assert.equal(url, audioUrl)
})

test('配置、过长文本与非预期音频地址都会被拒绝', async () => {
  await assert.rejects(synthesize('你好', { env: {} }), /配置/)
  await assert.rejects(synthesize('你好', { env: { ...env, DASHSCOPE_BASE_URL: 'https://example.com/compatible-mode/v1' } }), /真实兼容接口/)
  await assert.rejects(synthesize('你'.repeat(601)), /600/)
  await assert.rejects(synthesize('你好', { env, fetchImpl: async () => Response.json({ output: { audio: { url: 'http://127.0.0.1/private' } } }) }), /非预期/)
})

test('长回答使用提示，不从中间截断金额或业务限制', () => {
  assert.equal(selectSpeechText(result), result.answer)
  const long = selectSpeechText({ status: 'answered', answer: '你'.repeat(700) })
  assert.match(long, /查看文字内容/)
  assert.equal(long.includes('你'), false)
})

test('文字分析复用同一查询链路，并保留真实 SQL 与结果', async () => {
  let received
  const report = await analyze('九月各区域金额', {
    dataset: { databasePath: '/test.duckdb', context: { datasetId: 'sales', version: 'v1' } },
    provider: {
      mode: 'test-only',
      decide: async (question) => { received = question; return { action: 'query', sql: 'SELECT region, SUM(paid_amount) AS sales_amount FROM sales GROUP BY region', metric: '未扣退款销售额', scope: '九月已导入记录' } },
      explain: async (_question, _context, _decision, result) => `${result.rows[0].region} ${result.rows[0].sales_amount} 元。`
    },
    execute: async (path) => { assert.equal(path, '/test.duckdb'); return { rows: result.rows, truncated: false } }
  })
  assert.equal(received, '九月各区域金额')
  assert.equal(report.answer, result.answer.replace('1599', '1599.00'))
  assert.match(report.sql, /SELECT region/)
  assert.equal(report.status, 'answered')
})

/** 测试使用注入的假供应商，不读取密钥，也不产生云端调用费用。 */
async function withApp(services, run) {
  const server = createApp(services).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { await run(`http://127.0.0.1:${server.address().port}`) }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('转写不会自动分析；修改后的文字才会交给分析；朗读绑定服务端回答且缓存音频', async () => {
  let analyzes = 0
  let syntheses = 0
  await withApp({
    transcribe: async () => '华南销售额',
    analyze: async (question) => { analyzes++; assert.equal(question, '华东销售额'); return result },
    synthesize: async (text) => { syntheses++; assert.equal(text, result.answer); return audioUrl }
  }, async (base) => {
    const asr = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: webm })
    assert.deepEqual(await asr.json(), { text: '华南销售额' })
    assert.equal(analyzes, 0)
    const answer = await (await post(`${base}/api/ask`, { question: '华东销售额' })).json()
    assert.equal(analyzes, 1)
    for (let i = 0; i < 2; i++) {
      const spoken = await post(`${base}/api/speak`, { answerId: answer.answerId, text: '伪造内容' })
      assert.deepEqual(await spoken.json(), { audioUrl })
    }
    assert.equal(syntheses, 1)
    assert.equal((await post(`${base}/api/speak`, { answerId: 'unknown' })).status, 410)
    assert.equal((await post(`${base}/api/ask`, { question: '' })).status, 400)
  })
})

test('TTS 失败可以重试，已有分析结果保持有效', async () => {
  let attempt = 0
  await withApp({ analyze: async () => result, synthesize: async () => { if (++attempt === 1) throw new Error('TTS unavailable'); return audioUrl } }, async (base) => {
    const answer = await (await post(`${base}/api/ask`, { question: '九月金额' })).json()
    const first = await post(`${base}/api/speak`, { answerId: answer.answerId })
    assert.equal(first.status, 500)
    assert.match((await first.json()).error, /TTS unavailable/)
    assert.equal((await post(`${base}/api/speak`, { answerId: answer.answerId })).status, 200)
    assert.equal(answer.answer, result.answer)
  })
})

test('阻止跨站收费请求，页面不输出密钥', async () => {
  await withApp({}, async (base) => {
    assert.equal((await post(`${base}/api/ask`, { question: '你好' }, { Origin: 'https://untrusted.example' })).status, 403)
    const html = await (await fetch(base)).text()
    assert.match(html, /开始录音/)
    assert.doesNotMatch(html, /test-only-key|DASHSCOPE_API_KEY/)
    assert.equal((await fetch(`${base}/vendor/lucide.js`)).status, 200)
  })
})
