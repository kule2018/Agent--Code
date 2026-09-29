import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { StoryController } from './story.controller.js'
import { StoryService } from './story.service.js'
import { WorkspaceService } from './workspace.js'
import { AgentExecutionService } from './agents.js'
import { GameBuilderService } from './builder.js'
import { ProjectRepository } from './repository.js'

@Module({
  controllers: [StoryController],
  providers: [StoryService, WorkspaceService, AgentExecutionService, GameBuilderService, ProjectRepository]
})
class StoryModule {}

const app = await NestFactory.create(StoryModule)
app.enableCors({ origin: ['http://localhost:5183', 'http://127.0.0.1:5183'] })
await app.listen(Number(process.env.PORT ?? 4311), '127.0.0.1')
console.log(`Story API: http://127.0.0.1:${process.env.PORT ?? 4311}`)
