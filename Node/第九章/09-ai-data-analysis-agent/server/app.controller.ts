import { Controller, Get, Post, Param, Body, Res, UploadedFile, UseInterceptors, Inject } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { z } from 'zod'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { DatasetService } from './dataset.service.js'
import { AnalysisService } from './analysis.service.js'
import { MultimodalService } from './multimodal.service.js'
import { Storage, root } from './storage.js'
import { resultCsv } from './report.js'

const Mode = z.enum(['replay', 'ai'])
const ImportRequest = z.object({ uploadId: z.uuid(), sheet: z.string().min(1), mapping: z.object({ date: z.string(), region: z.string(), product: z.string(), paid: z.string(), refund: z.string() }) })

/** HTTP 入口只接收业务参数，数据路径和执行权限由服务端确定。 */
@Controller('api')
export class AppController {
  constructor(@Inject(DatasetService) private datasets: DatasetService, @Inject(AnalysisService) private analyses: AnalysisService, @Inject(MultimodalService) private multimodal: MultimodalService, @Inject(Storage) private storage: Storage) {}
  @Get('health') health() { return { ok: true } }
  @Get('meta') meta() { return { ai: Boolean(process.env.DEEPSEEK_API_KEY), speech: Boolean(process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_BASE_URL), vision: Boolean(process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_BASE_URL), model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash' } }
  @Get('datasets') listDatasets() { return this.datasets.list() }
  @Post('uploads')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File) { if (!file) throw new Error('请选择文件'); return this.datasets.upload(file.buffer, file.originalname) }
  @Post('datasets') async import(@Body() body: unknown) { const data = ImportRequest.parse(body); return this.datasets.import(data.uploadId, data.sheet, data.mapping) }
  @Get('datasets/:id/rows') async rows(@Param('id') id: string) { return (await this.storage.load<any[]>(join(this.storage.datasetDir(id), 'rows.json'))).slice(0, 20) }
  @Get('samples/:name') async sample(@Param('name') name: string, @Res() res: Response) {
    if (!['sales-demo.xlsx', 'sales-demo.csv', 'sales-issues.xlsx', 'dashboard.png'].includes(name)) throw new Error('样例不存在')
    res.attachment(name).send(await readFile(join(root, 'samples', name)))
  }
  @Get('sessions') listSessions() { return this.analyses.listSessions() }
  @Post('sessions') createSession(@Body() body: unknown) { return this.analyses.createSession(z.object({ datasetId: z.uuid() }).parse(body).datasetId) }
  @Get('sessions/:id') session(@Param('id') id: string) { return this.storage.session(id) }
  @Post('sessions/:id/analyze')
  async analyze(@Param('id') id: string, @Body() raw: unknown, @Res() response: Response) {
    const { question, mode } = z.object({ question: z.string().trim().min(1).max(2000), mode: Mode }).parse(raw)
    await streamResponse(response, async (signal, send) => {
      const report = await this.analyses.analyze(id, question, mode, signal, progress => send('progress', progress))
      send('report', report)
    })
  }
  @Get('sessions/:id/reports/:reportId/export')
  async export(@Param('id') id: string, @Param('reportId') reportId: string, @Res() res: Response) {
    res.type('html').attachment(`analysis-${reportId}.html`).send(await this.analyses.export(id, reportId))
  }
  @Get('sessions/:id/reports/:reportId/csv')
  async csv(@Param('id') id: string, @Param('reportId') reportId: string, @Res() res: Response) {
    const report = await this.analyses.findReport(id, reportId)
    res.type('text/csv').attachment(`result-${reportId}.csv`).send(resultCsv(report.table))
  }
  @Post('images')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  async image(@UploadedFile() file: Express.Multer.File, @Body('mode') rawMode: string) {
    if (!file) throw new Error('请选择图片')
    return this.multimodal.inspect(file.buffer, file.mimetype, Mode.parse(rawMode), AbortSignal.timeout(65000))
  }
  @Post('images/compare')
  async compare(@Body() body: unknown) {
    const data = z.object({ datasetId: z.uuid(), facts: z.unknown() }).parse(body)
    return this.multimodal.compare(data.datasetId, data.facts, AbortSignal.timeout(30000))
  }
  @Post('sessions/:id/reports/:reportId/speech')
  async speak(@Param('id') id: string, @Param('reportId') reportId: string, @Res() response: Response) {
    const report = await this.analyses.findReport(id, reportId)
    const sentences = report.answer.match(/[^。！？\n]+[。！？]?/g) || [report.answer]
    await streamResponse(response, async (signal, send) => {
      let seq = 0
      for (const sentence of sentences.slice(0, 8)) {
        signal.throwIfAborted()
        const audioUrl = await this.multimodal.speak([...sentence].slice(0, 500).join(''), signal)
        send('audio', { seq: seq++, audioUrl })
      }
      send('done', {})
    })
  }
}

/** NDJSON 逐条回传进度；浏览器停止后取消本轮，并丢弃迟到输出。 */
async function streamResponse(response: Response, run: (signal: AbortSignal, send: (event: string, data: unknown) => void) => Promise<void>) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('本轮超过 150 秒，请重试或缩小问题范围')), 150000)
  const close = () => { if (!response.writableEnded) controller.abort(new DOMException('用户停止本轮', 'AbortError')) }
  response.on('close', close)
  response.type('application/x-ndjson').setHeader('Cache-Control', 'no-cache')
  response.flushHeaders()
  const send = (event: string, data: unknown) => { if (!controller.signal.aborted && !response.destroyed) response.write(JSON.stringify({ event, data }) + '\n') }
  try { await run(controller.signal, send) }
  catch (error) { if (!response.destroyed) response.write(JSON.stringify({ event: 'error', data: { message: (error as Error).message } }) + '\n') }
  finally { clearTimeout(timer); response.off('close', close); response.end() }
}
