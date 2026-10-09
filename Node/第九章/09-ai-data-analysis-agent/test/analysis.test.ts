import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReport, buildSql, replayDecision } from '../server/analysis.js'
import { normalize, parseFile, previewSheet } from '../server/table-parser.js'
import { reportHtml, resultCsv } from '../server/report.js'
import { createAnalysisGraph } from '../server/workflow.js'
import { AnalysisProvider } from '../server/model.js'
import type { Dataset, Evidence, Session, Spec } from '../shared/types.js'

const dataset: Dataset = { id: crypto.randomUUID(), name: 'sales.csv', sheet: 'CSV', version: 1, checksum: 'abc', createdAt: '', rowCount: 18, status: 'ready', issues: [], start: '2026-07-15', end: '2026-09-15', regions: ['华东','华南'], products: ['咖啡机','键盘'], mapping: { date:'销售日期',region:'区域',product:'商品名称',paid:'实付金额（元）',refund:'退款金额（元）' } }
const session: Session = { id: crypto.randomUUID(), datasetId: dataset.id, title: '', createdAt: '', reports: [], lastSpec: null }
const spec: Spec = { kind: 'decline', metric: 'net', start: '2026-07-01', end: '2026-09-30', region: null }
const evidence = (rows: Evidence['rows'], override: Partial<Spec> = {}): Evidence => ({ id: crypto.randomUUID(), dataset, rows, spec: { ...spec, ...override }, sql: buildSql({ ...spec, ...override }), createdAt: '', durationMs: 10 })

test('CSV 映射保留日期和金额，空退款不被补零', async () => {
  const [sheet] = await parseFile(Buffer.from('销售日期,区域,商品名称,实付金额（元）,退款金额（元）\n2026-09-15,华东,咖啡机,100,\n'), 'sales.csv')
  const normalized = normalize(sheet, previewSheet(sheet).suggested)
  assert.equal(normalized.issues[0].field, '退款金额（元）')
  assert.equal(normalized.rows[0].paid_amount, '100.00')
})
test('非法日期、公式、退款超过实付及重复行均被标记', () => {
  const headers = Object.values(dataset.mapping)
  const good = ['2026-09-15','华东','咖啡机',100,0]
  const result = normalize({ name:'sales', cells:[headers, good, good, ['2026-09-31','华东','咖啡机',100,200], ['2026-09-15','华南','咖啡机',{formula:'1+1',result:2},0]] }, dataset.mapping)
  assert.ok(result.issues.some(i => i.message.includes('完全相同')))
  assert.ok(result.issues.some(i => i.message.includes('日期')))
  assert.ok(result.issues.some(i => i.message.includes('超过实付')))
  assert.ok(result.issues.some(i => i.message.includes('公式')))
})
test('趋势中的月份缺口不会按零处理或跨月判下降', () => {
  const report = buildReport('连续下降', 'replay', evidence([{month:'2026-07',region:'华东',amount:30000},{month:'2026-09',region:'华东',amount:20000}]))
  assert.deepEqual(report.chart!.series[0].values, [30000,null,20000])
  assert.match(report.answer, /没有数据完整/)
})
test('三个月才支持连续两次下降', () => {
  const report = buildReport('下降', 'replay', evidence([{month:'2026-07',region:'华东',amount:30000},{month:'2026-08',region:'华东',amount:25000},{month:'2026-09',region:'华东',amount:20000}]))
  assert.match(report.answer, /华东连续两个月下降/)
  assert.deepEqual(report.chart!.series[0].values,[30000,25000,20000])
})
test('商品净降幅贡献按真实相邻月份复算', () => {
  const report = buildReport('商品', 'replay', evidence([{month:'2026-08',product:'咖啡机',amount:'14000.00'},{month:'2026-09',product:'咖啡机',amount:'10000.00'},{month:'2026-08',product:'键盘',amount:'11000.00'},{month:'2026-09',product:'键盘',amount:'10000.00'}], {kind:'contribution',region:'华东'}))
  assert.equal(report.table[0]['净降幅贡献(%)'],80)
  assert.equal(report.table[1]['净降幅贡献(%)'],20)
})
test('没有净下降时不计算贡献百分比', () => {
  const report = buildReport('商品', 'replay', evidence([{month:'2026-08',product:'咖啡机',amount:100},{month:'2026-09',product:'咖啡机',amount:100}], {kind:'contribution',region:'华东'}))
  assert.equal(report.table[0]['净降幅贡献(%)'],null)
})
test('追问继承时间和口径，新增区域与维度', () => {
  const decision = replayDecision('只看华东，哪些商品贡献了主要降幅？',dataset,spec)
  assert.equal(decision.spec!.region,'华东')
  assert.equal(decision.spec!.kind,'contribution')
  assert.equal(decision.spec!.start,spec.start)
  assert.match(decision.sql!,/product_name AS product/)
})
test('实付与净额明确区分，因果问题给出资料不足', () => {
  const decision = replayDecision('9月全部区域实付金额是多少？',dataset,spec)
  assert.equal(decision.spec!.metric,'paid')
  assert.equal(decision.spec!.start,'2026-09-01')
  assert.equal(replayDecision('为什么用户不买咖啡机？',dataset,spec).route,'insufficient')
})
test('离线报告使用真实结果和 SVG，转义问题与 SQL', () => {
  const report = buildReport('<script>alert(1)</script>', 'replay', evidence([{region:'华东',amount:20000}],{kind:'summary'}))
  const html = reportHtml(report)
  assert.ok(html.includes('<svg'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>alert'))
  assert.ok(html.includes(dataset.checksum))
  assert.ok(resultCsv([{name:'=1+1'}]).includes("'=1+1"))
})
test('Graph 查询错误只补查一次，达到上限保留失败原因', async () => {
  let attempts=0
  const graph=createAnalysisGraph({question:'哪些区域连续下降？',dataset,session,mode:'replay',directory:'/tmp',signal:new AbortController().signal,emit:()=>{},execute:async()=>{attempts++;throw new Error('数据库不可用')}})
  const state=await graph.invoke({decision:null,evidence:null,error:'',attempts:0,report:null})
  assert.equal(attempts,2)
  assert.equal(state.report!.status,'insufficient')
  assert.equal(state.report!.evidence,null)
})
test('取消查询以后不生成完成报告', async () => {
  const controller=new AbortController()
  const graph=createAnalysisGraph({question:'按月趋势',dataset,session,mode:'replay',directory:'/tmp',signal:controller.signal,emit:()=>{},execute:async()=>{controller.abort(new DOMException('取消','AbortError'));return []}})
  await assert.rejects(graph.invoke({decision:null,evidence:null,error:'',attempts:0,report:null}),/取消/)
})
test('AI 请求包含 JSON 要求，传递信号并使用实际模型决策', async () => {
  let body:any
  const provider=new AnalysisProvider({DEEPSEEK_API_KEY:'unit-test',DEEPSEEK_MODEL:'test-model'}, async (_url,init)=>{
    body=JSON.parse(String(init!.body))
    return new Response(JSON.stringify({id:'completion',object:'chat.completion',created:0,model:'test-model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({route:'query',spec,sql:buildSql(spec),message:'查询'})}}]}),{headers:{'Content-Type':'application/json'}})
  })
  const decision=await provider.decide('哪些区域连续下降？',dataset,session,'ai',new AbortController().signal)
  assert.equal(decision.spec!.metric,'net')
  assert.equal(body.model,'test-model')
  assert.match(body.messages[0].content,/JSON/)
  assert.deepEqual(body.thinking,{type:'disabled'})
})
