import {
	BadRequestException,
	Body,
	Controller,
	Get,
	Inject,
	Param,
	Post,
	Res
} from '@nestjs/common'
import type { Response } from 'express'
import { PresentationService } from './presentation.service.js'
import {
	ApplyChangeSchema,
	CreatePresentationSchema,
	ReviewOutlineSchema,
	RevisePageSchema
} from './presentation.types.js'

@Controller('presentations')
export class PresentationController {
	constructor(
		@Inject(PresentationService)
		private readonly presentations: PresentationService
	) {}

	@Get()
	list() {
		return this.execute(() => this.presentations.list())
	}

	@Get('meta')
	meta() {
		return this.presentations.getMeta()
	}

	@Get(':id')
	get(@Param('id') id: string) {
		return this.execute(() => this.presentations.get(id))
	}

	// 创建一个新的演示文稿制作任务
	@Post()
	create(@Body() body: unknown) {
		// 统一处理业务执行流程，例如异常捕获、日志记录等
		return this.execute(() =>
			// 使用 Zod Schema 校验并转换请求参数，
			// 校验通过后调用领域服务创建演示文稿
			this.presentations.create(CreatePresentationSchema.parse(body))
		)
	}

	@Post(':id/review')
	review(@Param('id') id: string, @Body() body: unknown) {
		return this.execute(() =>
			this.presentations.review(id, ReviewOutlineSchema.parse(body))
		)
	}

	@Post(':id/continue')
	continuePages(@Param('id') id: string) {
		return this.execute(() => this.presentations.continuePages(id))
	}

	@Post(':id/pages/:pageId/revise')
	revisePage(
		@Param('id') id: string,
		@Param('pageId') pageId: string,
		@Body() body: unknown
	) {
		return this.execute(() => {
			const input = RevisePageSchema.parse(body)
			return this.presentations.revisePage(id, pageId, input.changeRequest)
		})
	}

	@Post(':id/changes')
	applyChange(@Param('id') id: string, @Body() body: unknown) {
		return this.execute(() =>
			this.presentations.applyChange(id, ApplyChangeSchema.parse(body))
		)
	}

	@Post(':id/export')
	export(@Param('id') id: string) {
		return this.execute(() => this.presentations.export(id))
	}

	@Get(':id/download')
	async download(@Param('id') id: string, @Res() response: Response) {
		try {
			const file = await this.presentations.getDownload(id)
			response.download(file.path, file.fileName)
		} catch (error) {
			throw new BadRequestException(this.message(error))
		}
	}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation()
		} catch (error) {
			throw new BadRequestException(this.message(error))
		}
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : '请求处理失败。'
	}
}
