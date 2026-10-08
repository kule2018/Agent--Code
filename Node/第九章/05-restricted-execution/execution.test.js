import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { loadDataset } from '../04-text-to-sql/dataset.js'
import { runSandbox, docker, validateResult } from './sandbox.js'
import { makeTask } from './execution-demo.js'
import { imageName } from './build-image.js'

let dataset
let originalHash
const rows = [{ region: '华东', sales_amount: '1599.00' }, { region: '华南', sales_amount: '798.00' }]
const hash = async () => createHash('sha256').update(await readFile(dataset.databasePath)).digest('hex')
const run = async (name, options = {}) => runSandbox(await makeTask(name, rows), { databasePath: dataset.databasePath, ...options })

before(async () => {
  await docker(['image', 'inspect', imageName])
  dataset = await loadDataset()
  originalHash = await hash()
})

test('SQL 在真实容器里执行，结果与 04 相同', async () => {
  const report = await run('sql')
  assert.equal(report.status, 'completed')
  assert.deepEqual(report.result.rows, rows)
  assert.equal(report.execution.network, 'none')
  assert.equal(report.execution.readOnly, true)
  assert.equal(report.execution.user, '1000:1000')
  assert.equal(report.execution.memoryBytes, 256 * 1024 * 1024)
  assert.equal(report.execution.nanoCpus, 1_000_000_000)
  assert.equal(report.execution.pidsLimit, 64)
  assert.deepEqual(report.execution.mounts.filter((m) => m.destination === '/input'), [{ destination: '/input', writable: false }])
  assert.equal(report.cleanedUp, true)
  assert.equal(await docker(['ps', '-aq', '--filter', `name=^/${report.containerName}$`]), '')
})

test('分析代码真实计算占比，宿主只接收结果', async () => {
  const report = await run('code')
  assert.equal(report.status, 'completed')
  assert.deepEqual(report.result.rows.map((row) => row.share_percent), ['66.71', '33.29'])
})

test('越权表、文件函数与删除 SQL 全部被拒绝', async () => {
  for (const name of ['sql-table', 'sql-file', 'sql-write']) {
    const report = await run(name)
    assert.equal(report.status, 'rejected', JSON.stringify(report))
    assert.match(report.error, /POLICY:/)
    assert.equal(report.cleanedUp, true)
  }
})

test('真实宿主探针存在，容器无法读取；只读输入不能改写', async () => {
  const read = await run('read-host')
  assert.equal(read.status, 'failed')
  assert.match(read.error, /ENOENT/)
  const write = await run('write-input')
  assert.equal(write.status, 'failed')
  assert.match(write.error, /EROFS|EACCES/)
})

test('容器无外部网络路由', async () => {
  const report = await run('network')
  assert.equal(report.status, 'failed')
  assert.equal(report.execution.network, 'none')
  assert.match(report.error, /ENETUNREACH|EHOSTUNREACH/)
})

test('不继承宿主环境变量，代码任务拿不到数据库', async () => {
  process.env.COURSE_RUNTIME_SENTINEL = 'host-only'
  try {
    const report = await runSandbox({ kind: 'code', rows, code: `
import { existsSync } from 'node:fs';
export default function () { return { rows: [{ secret: process.env.COURSE_RUNTIME_SENTINEL ?? null, hasDatabase: existsSync('/input/data.duckdb'), uid: process.getuid() }] }; }
` })
    assert.equal(report.status, 'completed')
    assert.deepEqual(report.result.rows[0], { secret: null, hasDatabase: false, uid: 1000 })
  } finally { delete process.env.COURSE_RUNTIME_SENTINEL }
})

test('死循环超时后整个容器已消失', async () => {
  const report = await run('timeout', { timeoutMs: 1500 })
  assert.equal(report.status, 'timeout')
  assert.equal(report.cleanedUp, true)
  assert.equal(await docker(['ps', '-aq', '--filter', `name=^/${report.containerName}$`]), '')
})

test('输出超量终止，错误 JSON 不进入后续分析', async () => {
  assert.equal((await run('output')).status, 'output_limit')
  const invalid = await runSandbox({ kind: 'code', rows, code: 'export default function () { return { answer: "没有 rows" }; }' })
  assert.equal(invalid.status, 'invalid_result')
  assert.throws(() => validateResult({ rows: [], truncated: true }), /截断/)
})

test('查询和失败测试没有改写原始数据库', async () => {
  assert.equal(await hash(), originalHash)
})

test('容器内存耗尽时识别 OOM 并清理', async () => {
  const report = await runSandbox({ kind: 'code', rows: [], code: `
export default function () { const buffers = []; for (let i = 0; i < 64; i++) buffers.push(Buffer.alloc(8 * 1024 * 1024, 1)); return { rows: [{ count: buffers.length }] }; }
` })
  assert.equal(report.status, 'resource_limit')
  assert.equal(report.cleanedUp, true)
})
