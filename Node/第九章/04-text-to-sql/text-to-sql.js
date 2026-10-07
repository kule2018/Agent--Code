import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { loadDataset, prepareDataset, projectDir } from './dataset.js'
import { createAIProvider, Decision } from './model.js'
import { executeQuery } from './query-runner.js'
import { createReplayProvider, scenarios } from './replay.js'

/** 从业务问题走到真实结果；只有 SQL 语法或字段错误允许修正一次。 */
export async function answerQuestion(question, dataset, provider, execute = executeQuery) {
  if (!question.trim() || question.length > 2000) throw new Error('问题需要在 1 到 2000 字符之间。')
  const report = { question, mode: provider.mode, datasetId: dataset.context.datasetId, version: dataset.context.version, attempts: [] }
  let previousError
  for (let attempt = 0; attempt < 2; attempt++) {
    const decision = Decision.parse(await provider.decide(question, dataset.context, previousError))
    if (decision.action === 'clarify') return { ...report, status: 'clarify', answer: decision.question }
    const record = { decision }
    report.attempts.push(record)
    let result
    try {
      result = await execute(dataset.databasePath, decision.sql)
    } catch (error) {
      record.error = error.message
      if (attempt === 0 && error.repairable) {
        previousError = { sql: decision.sql, error: error.message }
        continue
      }
      return { ...report, status: 'failed', answer: `查询未完成：${error.message}` }
    }
    const warning = '结果只代表已导入记录；日期覆盖范围不能证明月份完整，不外推完整月度业绩。'
    report.result = result
    report.warning = warning
    if (result.truncated) return { ...report, status: 'needs_narrowing', answer: '结果超过 100 行，仅展示前 100 行。请增加筛选或聚合后重新提问，不据此概括全部结果。' }
    if (!result.rows.length) return { ...report, status: 'empty', answer: '没有查到符合条件的记录。请核对筛选条件和数据范围；空结果不代表销售额为 0。' }
    try {
      return { ...report, status: 'answered', answer: await provider.explain(question, dataset.context, decision, result) }
    } catch (error) {
      return { ...report, status: 'explanation_failed', answer: `SQL 已完成，模型解读失败：${error.message}。请先核对下方真实结果。` }
    }
  }
}

/** 打印口径、SQL 和真实行数据，并保存同一份报告，方便回查本次查询。 */
async function printAndSave(report) {
  console.log(`\n模式：${report.mode}\n问题：${report.question}`)
  console.log(`数据集：${report.datasetId} / ${report.version.slice(0, 12)}`)
  for (const [index, attempt] of report.attempts.entries()) {
    console.log(`\n第 ${index + 1} 次查询\n口径：${attempt.decision.metric}\n范围：${attempt.decision.scope}\n\n${attempt.decision.sql}`)
    if (attempt.error) console.log(`\n错误：${attempt.error}`)
  }
  if (report.result) {
    console.log('\n数据库返回：')
    console.table(report.result.rows)
  }
  console.log(`\n状态：${report.status}\n${report.answer}`)
  if (report.warning) console.log(`\n注意：${report.warning}`)
  const output = join(projectDir, 'outputs', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`)
  await mkdir(join(projectDir, 'outputs'), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`\n本次记录：${output}`)
}

/** 命令入口：准备数据，或选择 AI / Replay 发起一次自然语言查询。 */
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args
  if (command === 'prepare') {
    const dataset = await prepareDataset()
    console.log(`数据已就绪：${dataset.databasePath}\n销售明细：${dataset.context.rowCount} 条；商品：2 个\n表：sales、products`)
    return
  }
  if (!['demo', 'ask'].includes(command)) throw new Error('用法：npm run prepare-data / npm run demo -- regions / npm run ask -- "问题"')
  const dataset = await loadDataset()
  const name = rest[0] || 'regions'
  const provider = command === 'demo' ? createReplayProvider(name) : createAIProvider()
  const question = command === 'demo' ? scenarios[name].question : rest.join(' ')
  if (command === 'ask') console.log('即将发送问题、Schema、统计口径及必要的查询结果给 DeepSeek，会产生 API 费用。')
  const report = await answerQuestion(question, dataset, provider)
  await printAndSave(report)
  if (['failed', 'explanation_failed'].includes(report.status)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`\n执行失败：${error.message}`); process.exitCode = 1 })
}
