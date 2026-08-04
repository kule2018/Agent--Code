import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

try {
	process.loadEnvFile()
} catch {
	// 没有 .env 时仍可使用不依赖模型密钥的 Replay 模式。
}

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.setGlobalPrefix('api')
	app.enableCors({ origin: true })
	const port = Number(process.env.PORT ?? 4300)
	await app.listen(port)
	console.log(`Software Engineering Agent API: http://localhost:${port}/api`)
}

void bootstrap()
