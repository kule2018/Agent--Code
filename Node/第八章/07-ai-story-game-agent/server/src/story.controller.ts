import { BadRequestException, Body, Controller, Get, Header, Headers, Inject, Param, Post, Query, Res, Sse } from '@nestjs/common'
import { concatMap, from, interval, mergeMap, startWith } from 'rxjs'
import type { Response } from 'express'
import { ProjectRepository } from './repository.js'
import { StoryService } from './story.service.js'
import { WorkspaceService } from './workspace.js'

/** 本地课程工作台 API；文件和 Release 始终由项目登记信息定位。 */
@Controller('api/projects')
export class StoryController {
  constructor(
    @Inject(StoryService) private readonly stories: StoryService,
    @Inject(ProjectRepository) private readonly repo: ProjectRepository,
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService
  ) {}

  @Get() list() { return this.repo.list() }

  @Get('meta') meta() {
    return { aiConfigured: Boolean(process.env.DEEPSEEK_API_KEY), modes: ['replay', 'ai'], database: 'PostgreSQL', replayScope: '失联太空站固定样本' }
  }

  @Post() create(@Body() input: unknown) { return this.stories.create(input) }

  @Get(':id') async get(@Param('id') id: string) { return this.repo.get(id) }

  @Get(':id/events') async events(@Param('id') id: string, @Query('after') after?: string) {
    await this.repo.get(id)
    return this.repo.events(id, Number(after ?? 0))
  }

  @Sse(':id/events/live') live(@Param('id') id: string, @Query('after') after?: string, @Headers('last-event-id') lastEventId?: string) {
    let last = Number(lastEventId ?? after ?? 0)
    return interval(1000).pipe(
      startWith(0),
      concatMap(async () => {
        await this.repo.get(id)
        const events = await this.repo.events(id, last)
        if (events.length) last = events.at(-1)!.id
        return events
      }),
      mergeMap((events) => from(events.map((event) => ({ id: String(event.id), data: event }))))
    )
  }

  @Post(':id/outline-review') async review(@Param('id') id: string, @Body() input: { outlineVersion: number; decision: 'approve' | 'revise' | 'reject'; feedback?: string }) {
    if (!['approve', 'revise', 'reject'].includes(input?.decision)) throw new BadRequestException('审核决定不合法。')
    await this.stories.reviewOutline(id, input)
    return { accepted: true }
  }

  @Post(':id/revise-scene') async revise(@Param('id') id: string, @Body() input: { sceneId: string; instruction: string }) {
    await this.stories.reviseScene(id, input.sceneId, input.instruction)
    return { accepted: true }
  }

  @Post(':id/retry') async retry(@Param('id') id: string) { await this.stories.retry(id); return { accepted: true } }

  @Post(':id/cancel') async cancel(@Param('id') id: string) { await this.stories.cancel(id); return { accepted: true } }

  @Get(':id/files') async files(@Param('id') id: string) {
    const project = await this.repo.get(id)
    return this.workspace.listFiles(id, project.revision)
  }

  @Get(':id/file') async file(@Param('id') id: string, @Query('path') path: string) {
    const files = await this.files(id)
    if (!files.includes(path)) throw new BadRequestException('文件不属于当前项目版本。')
    return { path, content: await this.workspace.readText(id, path) }
  }

  @Get(':id/releases/:releaseId/game') async game(@Param('id') id: string, @Param('releaseId') releaseId: string) {
    await this.assertRelease(id, releaseId)
    return this.workspace.readJson(id, `/releases/${releaseId}/game.json`)
  }

  @Get(':id/releases/:releaseId/play')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async play(@Param('id') id: string, @Param('releaseId') releaseId: string, @Res() response: Response) {
    await this.assertRelease(id, releaseId)
    response.send(await this.workspace.readText(id, `/releases/${releaseId}/index.html`))
  }

  @Get(':id/releases/:releaseId/download')
  async download(@Param('id') id: string, @Param('releaseId') releaseId: string, @Res() response: Response) {
    await this.assertRelease(id, releaseId)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="story-game-${releaseId}.html"`)
    response.send(await this.workspace.readText(id, `/releases/${releaseId}/index.html`))
  }

  private async assertRelease(id: string, releaseId: string): Promise<void> {
    const project = await this.repo.get(id)
    if (!project.releaseIds.includes(releaseId)) throw new BadRequestException('游戏版本不属于当前项目。')
  }
}
