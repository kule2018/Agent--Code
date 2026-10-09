import 'reflect-metadata'
import { Module, Controller, Get } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { WsAdapter } from '@nestjs/platform-ws'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { VoiceGateway } from './voice.gateway.js'
import { VoiceService } from './voice.service.js'

const port = Number(process.env.PORT || 4316)
const webPort = Number(process.env.WEB_PORT || 5186)
const origins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`])

/** 本地教学服务也限制 WebSocket 来源，防止其他网页借用本机密钥调用模型。 */
class LocalWsAdapter extends WsAdapter {
  create(port: number, options: any = {}) {
    return super.create(port, { ...options, verifyClient: (info: any) => {
      return origins.has(info.origin) && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(info.req.headers.host || '')
    } })
  }
}
@Controller('api')
class HealthController {
  @Get('health') health() { return { ok: true } }
}
@Module({ controllers: [HealthController], providers: [VoiceService, VoiceGateway] })
class AppModule {}

/** 启动 NestJS；前端由 Vite 提供，只监听本机地址。 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  app.useWebSocketAdapter(new LocalWsAdapter(app))
  app.enableShutdownHooks()
  await app.listen(port, '127.0.0.1')
  console.log(`语音服务：http://127.0.0.1:${port}；页面：http://localhost:${webPort}`)
}
bootstrap().catch(error => { console.error(error.message); process.exitCode = 1 })
