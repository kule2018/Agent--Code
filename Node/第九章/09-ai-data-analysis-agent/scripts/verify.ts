import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage, root } from '../server/storage.js'
import { DatasetService } from '../server/dataset.service.js'
import { AnalysisService } from '../server/analysis.service.js'
import { MultimodalService } from '../server/multimodal.service.js'
import { executeQuery } from '../server/sandbox.js'
import { escapeHtml } from '../server/report.js'

/** 使用实际 Excel、DuckDB 与 Docker 验证整条演示链路，不调用收费 API。 */
const directory=await mkdtemp(join(tmpdir(),'analysis-verify-'))
try {
  const storage=new Storage(directory), datasets=new DatasetService(storage), analyses=new AnalysisService(storage)
  const uploaded=await datasets.upload(await readFile(join(root,'samples/sales-demo.xlsx')),'sales-demo.xlsx')
  const mapping=uploaded.sheets.find(s=>s.name==='销售明细')!.suggested
  const imported=await datasets.import(uploaded.id,'销售明细',mapping)
  assert.equal(imported.dataset.rowCount,18)
  assert.equal(imported.dataset.status,'ready')
  assert.equal((await datasets.import(uploaded.id,'销售明细',mapping)).repeated,true)
  console.log('✓ Excel 导入 18 行，重复内容复用原版本')
  const session=await analyses.createSession(imported.dataset.id), signal=new AbortController().signal
  const analyze=(question:string)=>analyses.analyze(session.id,question,'replay',signal,()=>{})
  const first=await analyze('哪些区域连续两个月净销售额下降？')
  assert.match(first.answer,/华东连续两个月下降/)
  assert.ok(!first.answer.includes('华南连续'))
  console.log('✓ 实际容器查询：华东 30000 → 25000 → 20000')
  const second=await analyze('只看华东，哪些商品贡献了主要降幅？')
  assert.equal(second.table[0]['净降幅贡献(%)'],80)
  assert.equal(second.table[1]['净降幅贡献(%)'],20)
  console.log('✓ 追问继承条件，咖啡机贡献 4000 元 / 80%，键盘 1000 元 / 20%')
  const recovered=await new Storage(directory).session(session.id)
  assert.equal(recovered.reports.length,2)
  assert.equal(recovered.lastSpec!.region,'华东')
  const html=await analyses.export(session.id,second.id)
  assert.ok(html.includes('<svg')&&html.includes(escapeHtml(second.evidence!.sql)))
  console.log('✓ 重建服务后可读取历史；离线报告包含真实图表和 SQL')
  const multimodal=new MultimodalService(storage)
  const facts=await multimodal.inspect(await readFile(join(root,'samples/dashboard.png')),'image/png','replay',signal)
  const comparison=await multimodal.compare(imported.dataset.id,facts,signal)
  assert.equal(comparison.total,60000)
  assert.equal(comparison.difference,0)
  console.log('✓ 截图实付金额 60000 元与原表同口径一致')
  const bad=await datasets.upload(await readFile(join(root,'samples/sales-issues.xlsx')),'sales-issues.xlsx')
  const badDataset=(await datasets.import(bad.id,'销售明细',bad.sheets[0].suggested)).dataset
  assert.equal(badDataset.status,'needs_review')
  await assert.rejects(analyses.createSession(badDataset.id),/质量问题/)
  console.log('✓ 质量问题阻止查询，不自动丢弃问题行')
  await assert.rejects(executeQuery(join(storage.datasetDir(imported.dataset.id),'data.duckdb'),'DELETE FROM sales',signal),/SELECT|POLICY/)
  await assert.rejects(executeQuery(join(storage.datasetDir(imported.dataset.id),'data.duckdb'),"SELECT * FROM read_csv('/etc/passwd')",signal),/POLICY/)
  console.log('✓ 删除数据和外部文件读取被实际查询策略拒绝')
  console.log('全部项目验证通过。')
} finally { await rm(directory,{recursive:true,force:true}) }
