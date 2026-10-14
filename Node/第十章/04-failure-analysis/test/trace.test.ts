import 'reflect-metadata'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NestFactory } from '@nestjs/core'
import { TraceService } from '../src/trace.service.js'
import { buildToolMessage, TracedAgentService, type Variant } from '../src/agent.service.js'
import { AppModule } from '../src/main.js'
import { summarize } from '../src/report.js'
import { EvaluationService } from '../../03-automatic-scoring/src/evaluation.service.js'
import { loadCase } from '../../03-automatic-scoring/src/sample.js'

test('错误转换可复现，且不会污染原始业务资料', () => {
  const result = { found: true, order: loadCase().fixture.orders[0] }
  const before = structuredClone(result)
  assert.equal(JSON.parse(buildToolMessage(result, 'wrong-unit')).order.paidAmountYuan,
    result.order.paidAmountYuan / 100)
  assert.deepEqual(result, before)
  assert.deepEqual(JSON.parse(buildToolMessage(result, 'fixed')), result)
})

test('输入与输出保存当时快照；子步骤关联父步骤', async () => {
  const trace = new TraceService()
  const messages = [{ role: 'user', content: '查询' }]
  const result = { amount: 3500 }
  await trace.capture('parent', 'agent', {}, () =>
    trace.capture('child', 'tool', { messages }, () => result))
  messages.push({ role: 'assistant', content: '后加的消息' })
  result.amount = 1
  assert.equal(trace.spans[1].parentId, trace.spans[0].id)
  assert.equal((trace.spans[1].input as { messages: unknown[] }).messages.length, 1)
  assert.deepEqual(trace.spans[1].output, { amount: 3500 })
})

test('并发子任务不会串联父节点', async () => {
  const trace = new TraceService()
  await Promise.all(['a', 'b'].map((name) => trace.capture(name, 'agent', {}, async () => {
    await new Promise((resolve) => setTimeout(resolve, 2))
    return trace.capture(`${name}.child`, 'tool', {}, () => true)
  })))
  for (const name of ['a', 'b']) {
    assert.equal(trace.spans.find((s) => s.name === `${name}.child`)!.parentId,
      trace.spans.find((s) => s.name === name)!.id)
  }
})

test('异常保留步骤信息，并继续抛出', async () => {
  const trace = new TraceService()
  await assert.rejects(trace.capture('get_order', 'tool', {}, () => {
    throw new Error('测试超时')
  }), /测试超时/)
  assert.equal(trace.spans[0].status, 'error')
  assert.equal(trace.spans[0].error, '测试超时')
  assert.ok(trace.spans[0].durationMs >= 0)
})

test('模型缺少 usage 时显示未知；未调用的 Judge 才是零调用', async () => {
  const trace = new TraceService()
  await trace.capture('agent.model', 'model', {}, () => ({ usage: null }))
  assert.equal(summarize(trace.spans, 'agent').totalTokens, null)
  assert.equal(summarize(trace.spans, 'agent').missingUsageCalls, 1)
  assert.equal(summarize(trace.spans, 'judge').modelCalls, 0)
  assert.equal(summarize(trace.spans, 'judge').totalTokens, 0)
})

test('本地 HTTP 替身验证真实 SDK、Nest 注入、评分与追踪，不访问模型服务', async (t) => {
  let failRole = ''
  let wrongOrder = false
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const isJudge = !!body.response_format
    if (failRole === (isJudge ? 'judge' : 'agent')) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: '测试用上游不可用', type: 'server_error' } }))
      return
    }
    const tool = body.messages.filter((m: { role: string }) => m.role === 'tool').at(-1)
    let message: unknown
    let finishReason = 'stop'
    if (isJudge) {
      const input = JSON.parse(body.messages.at(-1).content)
      message = {
        role: 'assistant', content: JSON.stringify({
          score: input.answer === '订单 A1024 的实付金额是 3500 元。' ? 2 : 0,
          reason: '测试替身按本样本确定性核对金额。', quotes: [input.answer]
        })
      }
    } else if (tool) {
      const order = JSON.parse(tool.content).order
      message = { role: 'assistant', content: order
        ? `订单 ${order.orderId} 的实付金额是 ${order.paidAmountYuan} 元。` : '未查到订单。' }
    } else {
      finishReason = 'tool_calls'
      message = { role: 'assistant', content: null, tool_calls: [{
        id: 'call-test-1', type: 'function', function: {
          name: 'get_order', arguments: JSON.stringify({ orderId: wrongOrder ? 'A9999' : 'A1024' })
        }
      }] }
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      id: 'test-completion', object: 'chat.completion', created: 0,
      model: 'http-test-model', choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const keys = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'JUDGE_MODEL'] as const
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  process.env.DEEPSEEK_API_KEY = 'test-secret-not-for-traces'
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.DEEPSEEK_MODEL = 'http-test-model'
  process.env.JUDGE_MODEL = 'http-test-judge'
  const execute = async (variant: Variant) => {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false, abortOnError: false })
    try {
      const trace = app.get(TraceService)
      const { sample, fixture } = loadCase()
      const run = await trace.capture('agent.run', 'agent', sample.inputs,
        () => app.get(TracedAgentService).run(sample.inputs, fixture.orders, variant))
      const evaluation = await trace.capture('evaluation.run', 'evaluation', { sample, run },
        () => app.get(EvaluationService).evaluate(sample, run))
      assert.ok(!JSON.stringify(trace.snapshot()).includes('test-secret-not-for-traces'))
      return { trace, run, evaluation }
    } finally { await app.close() }
  }
  try {
    await t.test('故障的工具返回 3500，第二次模型输入 35，规则通过但回答未通过', async () => {
      const { trace, run, evaluation } = await execute('wrong-unit')
      assert.equal(run.toolCalls[0].result.order?.paidAmountYuan, 3500)
      assert.equal(run.answer, '订单 A1024 的实付金额是 35 元。')
      assert.equal(evaluation.status, 'failed')
      assert.ok(evaluation.rules.every((rule) => rule.passed))
      const models = trace.spans.filter((span) => span.name === 'agent.model')
      const first = models[0].input as { messages: any[] }
      const second = models[1].input as { messages: any[] }
      assert.equal(first.messages.length, 2)
      assert.equal(JSON.parse(second.messages.at(-1).content).order.paidAmountYuan, 35)
      assert.ok(!JSON.stringify(first.messages).includes('3500'))
      assert.equal(summarize(trace.spans, 'agent').totalTokens, 240)
      assert.equal(summarize(trace.spans, 'judge').totalTokens, 120)
    })
    await t.test('修复后金额正确，同一评分器通过', async () => {
      const { evaluation, run } = await execute('fixed')
      assert.equal(run.answer, '订单 A1024 的实付金额是 3500 元。')
      assert.equal(evaluation.status, 'passed')
    })
    await t.test('附加实验实际执行两次查询，对应同一个模型 Tool Call', async () => {
      const { trace, run, evaluation } = await execute('repeat')
      assert.equal(run.toolCalls.length, 2)
      assert.equal(evaluation.status, 'passed')
      const calls = trace.spans.filter((span) => span.kind === 'tool')
      assert.deepEqual(calls[0].input, calls[1].input)
      assert.deepEqual(calls[0].output, calls[1].output)
    })
    await t.test('查错目标保留工具记录，规则失败跳过 Judge', async () => {
      wrongOrder = true
      try {
        const { trace, evaluation } = await execute('fixed')
        assert.equal(evaluation.status, 'failed')
        assert.equal(evaluation.judge.status, 'skipped')
        assert.equal(summarize(trace.spans, 'judge').modelCalls, 0)
      } finally { wrongOrder = false }
    })
    await t.test('答题模型异常归入 agent_error', async () => {
      failRole = 'agent'
      try {
        const { trace, evaluation } = await execute('fixed')
        assert.equal(evaluation.status, 'agent_error')
        assert.equal(trace.spans.find((s) => s.name === 'agent.model')!.status, 'error')
        assert.equal(summarize(trace.spans, 'agent').totalTokens, null)
      } finally { failRole = '' }
    })
    await t.test('评分服务异常归入 evaluation_error，不当作答题失败', async () => {
      failRole = 'judge'
      try {
        const { trace, run, evaluation } = await execute('fixed')
        assert.equal(run.status, 'completed')
        assert.equal(evaluation.status, 'evaluation_error')
        assert.equal(trace.spans.find((s) => s.name === 'judge.model')!.status, 'error')
      } finally { failRole = '' }
    })
  } finally {
    for (const key of keys) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
