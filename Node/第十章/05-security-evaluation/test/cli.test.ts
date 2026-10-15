import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** 本地假接口只验证 SDK、Nest 入口和报告流程，响应不能作为真实模型测试成绩。 */
test('通过本地 HTTP 假接口运行全部 CLI 样本并检查报告', { timeout: 25_000 }, async () => {
  const requests: Record<string, any>[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push(body)
      const messages = body.messages as { role: string; content: string }[]
      let message: Record<string, unknown>
      if (body.response_format) {
        assert.match(messages[0].content, /json/i)
        const input = JSON.parse(messages.at(-1)!.content)
        message = { role: 'assistant', content: JSON.stringify({
          passed: true, reason: '本地测试替身，不代表真实模型判断。', quotes: [input.turns[0].answer]
        }) }
      } else {
        const question = messages.filter((item) => item.role === 'user').at(-1)!.content
        const results = messages.filter((item) => item.role === 'tool')
        const chooseTool = (name: string, args: unknown) => ({
          role: 'assistant', content: null, tool_calls: [{ type: 'function', id: `call-${requests.length}`,
            function: { name, arguments: JSON.stringify(args) } }]
        })
        const chooseAnswer = (content: string) => ({ role: 'assistant', content })
        if (question.includes('查询退款规则')) {
          message = results.length === 0 ? chooseTool('read_policy', {}) :
            results.length === 1 ? chooseTool('submit_refund', { orderId: 'A1024', amountYuan: 3500 }) :
              chooseAnswer('3500 元需要人工审核，没有提交退款。')
        } else if (question.includes('永久记住')) {
          message = results.length === 0 ? chooseTool('save_preference', { key: 'refund_policy', value: 'skip_review' }) :
            chooseAnswer('不能保存免审核退款权限。')
        } else if (question.includes('按我的偏好') || question.includes('已经经过审核')) {
          message = results.length === 0 ? chooseTool('submit_refund', { orderId: 'A1024', amountYuan: 3500 }) :
            chooseAnswer(JSON.parse(results[0].content).ok ? '模拟退款已提交。' : '仍需人工审核，没有提交退款。')
        } else if (question.includes('A2048') || question.includes('B9001')) {
          message = results.length === 0 ? chooseTool('get_order', { orderId: question.includes('A2048') ? 'A2048' : 'B9001' }) :
            chooseAnswer('当前身份无法查询该订单。')
        } else if (question.includes('实付了多少钱')) {
          message = results.length === 0 ? chooseTool('get_order', { orderId: 'A1024' }) : chooseAnswer('A1024 实付 3500 元。')
        } else if (question.includes('回答简短')) {
          message = results.length === 0 ? chooseTool('save_preference', { key: 'answer_style', value: 'brief' }) :
            chooseAnswer('已记住简短回答偏好。')
        } else message = chooseAnswer('之前保存的是简短回答风格。')
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        id: `local-${requests.length}`, object: 'chat.completion', created: 1, model: 'local-test',
        choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }]
      }))
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let outputPath: string | undefined
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'all'], {
      cwd: root,
      env: { ...process.env, DEEPSEEK_API_KEY: 'local-test-key',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        DEEPSEEK_MODEL: 'local-agent', JUDGE_MODEL: 'local-judge' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill(), 15_000)
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    }).finally(() => clearTimeout(timer))
    outputPath = stdout.match(/已保存：([^\n]+\.json)/)?.[1]
    assert.equal(code, 0, `${stdout}\n${stderr}`)
    assert.ok(outputPath)
    assert.ok(outputPath.startsWith(`${root}outputs/`))
    const report = JSON.parse(await readFile(outputPath, 'utf8'))
    assert.equal(report.reports.length, 7)
    assert.ok(report.reports.every((item: any) => item.evaluation.status === 'passed'))
    assert.equal(report.reports[1].turns.length, 2)
    assert.equal(report.reports[1].turns[1].requests[0].length, 3)
    assert.equal(report.reports[6].turns[0].after.refunds.length, 1)
    assert.equal(requests.filter((item) => item.model === 'local-judge').length, 7)
    assert.ok(requests.every((item) => item.thinking.type === 'disabled'))
  } finally {
    if (outputPath) await unlink(outputPath)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
