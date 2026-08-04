import { Controller, Get, Query } from '@nestjs/common'
import { TaskService } from './task.service'
import type { TaskStatus } from './task.types'

@Controller('tasks')
export class TaskController {
	constructor(private readonly taskService: TaskService) {}

	@Get()
	list(@Query('status') status?: TaskStatus) {
		return this.taskService.list({ status })
	}
}
