import 'dotenv/config'
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'
import { PresentationService } from './presentation/presentation.service.js'

async function bootstrap() {
	const app = await NestFactory.create(AppModule)
	app.setGlobalPrefix('api')
	app.enableCors({ origin: true })

	await app.get(PresentationService).setup()
	await app.listen(4310)
	console.log('AI 演示文稿制作 Agent 已启动：http://localhost:4310/api')
}

bootstrap().catch((error) => {
	console.error(error)
	process.exitCode = 1
})

