import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Module, Catch, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common'
import { WsAdapter } from '@nestjs/platform-ws'
import { Storage } from './storage.js'
import { DatasetService } from './dataset.service.js'
import { AnalysisService } from './analysis.service.js'
import { MultimodalService } from './multimodal.service.js'
import { AppController } from './app.controller.js'
import { VoiceGateway } from './voice/voice.gateway.js'

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse()
    if (res.headersSent) return res.end()
    const message = error.name === 'ZodError' ? error.issues.map((issue: any) => `${issue.path.join('.')}: ${issue.message}`).join('；') : error.code === 'ENOENT' ? '记录或文件不存在，请检查数据集与样例文件' : error.message || '请求失败'
    res.status(error.getStatus?.() || 400).json({ message })
  }
}
@Module({ controllers: [AppController], providers: [{ provide: Storage, useFactory: () => new Storage() }, DatasetService, AnalysisService, MultimodalService, VoiceGateway] })
class AppModule {}

/** 启动本地分析服务和实时识别连接；密钥仅从服务端环境读取。 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const adapter = new WsAdapter(app)
  const webPort = Number(process.env.WEB_PORT || 5187)
  const origins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`])
  const create = adapter.create.bind(adapter)
  adapter.create = (port: number, options: any = {}) => create(port, { ...options, maxPayload: 128 * 1024, verifyClient: (info: any) => origins.has(info.origin) })
  app.useWebSocketAdapter(adapter)
  app.useGlobalFilters(new ApiErrors())
  app.enableShutdownHooks()
  await app.listen(Number(process.env.PORT || 4317), '127.0.0.1')
  console.log(`数据分析服务已就绪；页面：http://localhost:${webPort}`)
}
bootstrap().catch(error => { console.error(error.message); process.exitCode = 1 })
