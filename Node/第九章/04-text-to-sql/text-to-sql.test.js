import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { prepareDataset, loadDataset } from './dataset.js'
import { executeQuery } from './query-runner.js'
import { answerQuestion } from './text-to-sql.js'
import { scenarios, createReplayProvider, regionSql, comparisonSql, productSql } from './replay.js'
import { createAIProvider } from './model.js'

let root
let dataset
let originalHash
const checksum = async () => createHash('sha256').update(await readFile(dataset.databasePath)).digest('hex')
const run = (sql, options) => executeQuery(dataset.databasePath, sql, options)
const replay = (name) => answerQuestion(scenarios[name].question, dataset, createReplayProvider(name))

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'course-text-to-sql-'))
  dataset = await prepareDataset(root)
  originalHash = await checksum()
})
after(async () => { await rm(root, { recursive: true, force: true }) })

test('从上一节导入真实销售数据和商品表，模型上下文不携带明细正文', () => {
  assert.equal(dataset.context.rowCount, 6)
  assert.equal(dataset.context.schemas.products.length, 3)
  assert.equal(dataset.context.samples, undefined)
  assert.equal(dataset.context.databasePath, undefined)
})

test('区域聚合金额与样本人工计算相同', async () => {
  assert.deepEqual((await run(regionSql)).rows, [
    { region: '华东', sales_amount: '1599.00' },
    { region: '华南', sales_amount: '798.00' }
  ])
})

test('月份对比与环比正确，NULLIF 处理零分母', async () => {
  const { rows } = await run(comparisonSql)
  assert.equal(rows[0].august_amount, '2799.50')
  assert.equal(rows[0].change_amount, '-1200.50')
  assert.equal(rows[0].change_percent, -42.88)
  assert.equal(rows[1].change_percent, -33.5)
  const zero = await run('SELECT SUM(paid_amount) / NULLIF(0, 0) AS ratio FROM sales')
  assert.equal(zero.rows[0].ratio, null)
})

test('商品 JOIN 按唯一编号关联，变化绝对值排序', async () => {
  const { rows } = await run(productSql)
  assert.equal(rows[0].product_name, '全自动咖啡机')
  assert.equal(rows[0].change_amount, '-2400.50')
  assert.equal(rows[1].change_amount, '798.00')
})

test('订单按编号去重，扣退款口径与明细数分开', async () => {
  const { rows } = await run('SELECT COUNT(*) AS lines, COUNT(DISTINCT order_id) AS orders, SUM(paid_amount - refund_amount) AS net FROM sales')
  assert.deepEqual(rows[0], { lines: '6', orders: '5', net: '6097.50' })
})

test('缺失月份保持 NULL，不伪造为零', async () => {
  const { rows } = await run("SELECT SUM(CASE WHEN sold_at < DATE '2026-08-01' THEN paid_amount END) AS july FROM sales")
  assert.equal(rows[0].july, null)
})

test('模糊问题和样本覆盖不足时追问，不执行 SQL', async () => {
  for (const name of ['clarify', 'coverage']) {
    const report = await answerQuestion(scenarios[name].question, dataset, createReplayProvider(name), () => { throw new Error('不应执行') })
    assert.equal(report.status, 'clarify')
    assert.deepEqual(report.attempts, [])
  }
})

test('空结果单独输出，不能作为零销售', async () => {
  const report = await replay('empty')
  assert.equal(report.status, 'empty')
  assert.match(report.answer, /不代表销售额为 0/)
})

test('真实 Binder Error 返回后只修正一次', async () => {
  const report = await replay('repair')
  assert.equal(report.status, 'answered')
  assert.equal(report.attempts.length, 2)
  assert.match(report.attempts[0].error, /Binder Error/)
  assert.equal(report.result.rows[0].sales_amount, '1599.00')
})

test('第二次仍然错误就停止，并把失败 SQL 传回 Provider', async () => {
  let calls = 0
  const report = await answerQuestion('查询销售额', dataset, {
    mode: 'test',
    async decide(_question, _context, previousError) {
      calls++
      if (calls === 2) assert.match(previousError.error, /Binder Error/)
      return { ...scenarios.regions.decisions[0], sql: 'SELECT SUM(unknown_amount) FROM sales' }
    },
    async explain() { throw new Error('不应解释失败查询') }
  })
  assert.equal(report.status, 'failed')
  assert.equal(calls, 2)
})

test('拒绝写入、多语句、非业务表、外部文件和未开放查询结构', async () => {
  const forbidden = [
    'DELETE FROM sales',
    'SELECT * FROM sales; DROP TABLE products',
    'SELECT * FROM sales_raw',
    "SELECT * FROM read_csv_auto('/tmp/private.csv')",
    'WITH x AS (SELECT * FROM sales) SELECT * FROM x',
    'SELECT * FROM (SELECT * FROM sales) AS x',
    'SELECT random() FROM sales',
    'SELECT * FROM sales UNION ALL SELECT * FROM sales'
  ]
  for (const sql of forbidden) {
    await assert.rejects(run(sql), (error) => error.message.startsWith('POLICY:') && !error.repairable, sql)
  }
})

test('权限拒绝不会反复交给模型尝试', async () => {
  let calls = 0
  const report = await answerQuestion('删除销售表', dataset, {
    mode: 'test',
    async decide() { calls++; return { ...scenarios.regions.decisions[0], sql: 'DELETE FROM sales' } }
  })
  assert.equal(report.status, 'failed')
  assert.equal(calls, 1)
})

test('解析器处理分号和注释，不靠 SELECT 前缀字符串判断', async () => {
  const { rows } = await run("/* 教学查询 */ SELECT ';' AS text, COUNT(*) AS n FROM sales;")
  assert.equal(rows[0].text, ';')
  assert.equal(rows[0].n, '6')
})

test('结果行数超限会标记，查询子进程超时可终止', async () => {
  const limited = await run('SELECT * FROM sales ORDER BY source_row', { maxRows: 1 })
  assert.equal(limited.rows.length, 1)
  assert.equal(limited.truncated, true)
  await assert.rejects(run(regionSql, { timeoutMs: 1 }), /超时/)
})

test('截断结果不交给模型概括，模型解读失败保留真实结果', async () => {
  const report = await answerQuestion('按区域统计', dataset, createReplayProvider('regions'), async () => ({ rows: [], truncated: true }))
  assert.equal(report.status, 'needs_narrowing')
  const provider = createReplayProvider('regions')
  provider.explain = async () => { throw new Error('模拟 API 故障') }
  const failed = await answerQuestion('按区域统计', dataset, provider)
  assert.equal(failed.status, 'explanation_failed')
  assert.equal(failed.result.rows.length, 2)
})

test('模型格式错误与缺失密钥给出错误，不编造 SQL 或答案', async () => {
  await assert.rejects(answerQuestion('统计', dataset, { async decide() { return { sql: 'SELECT 1' } } }))
  assert.throws(() => createAIProvider({}), /DEEPSEEK_API_KEY/)
})

test('生成 SQL 和解读结果的请求都明确要求 JSON 输出', async (t) => {
  const requests = []
  const answer = '已导入的 2026 年 9 月记录中，未扣退款销售额：华东 1599 元，华南 798 元。'
  // 模拟供应商的 JSON 模式校验，不读取真实密钥或发送云端请求。
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (!body.messages.some((message) => /json/i.test(message.content))) {
      return Response.json({ error: { message: "Prompt must contain the word 'json'" } }, { status: 400 })
    }
    const content = requests.length === 1 ? scenarios.regions.decisions[0] : { answer }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] })
  })
  const provider = createAIProvider({ DEEPSEEK_API_KEY: 'test-only-key' })
  const report = await answerQuestion(scenarios.regions.question, dataset, provider)
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.deepEqual(request.response_format, { type: 'json_object' })
    assert.match(request.messages[0].content, /json/i)
  }
  assert.deepEqual(JSON.parse(requests[1].messages[1].content).result, report.result)
  assert.equal(report.status, 'answered')
  assert.equal(report.answer, answer)
})

test('待核对的数据集不能进入分析', async () => {
  const path = join(dirname(dataset.databasePath), 'profile.json')
  const original = await readFile(path, 'utf8')
  try {
    await writeFile(path, JSON.stringify({ ...JSON.parse(original), status: 'needs_review' }))
    await assert.rejects(loadDataset(root), /尚未通过检查/)
  } finally { await writeFile(path, original) }
})

test('所有查询和拒绝操作结束以后，数据库内容未被改写', async () => {
  assert.equal(await checksum(), originalHash)
})
