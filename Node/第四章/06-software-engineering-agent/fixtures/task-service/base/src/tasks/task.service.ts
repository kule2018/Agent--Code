import { Injectable } from '@nestjs/common'
import type { TaskFilters, TaskRecord } from './task.types'

@Injectable()
export class TaskService {
	private readonly tasks: TaskRecord[] = [
		{
			id: 'T-1001',
			title: '补充 Agent Runtime 测试',
			status: 'in_progress',
			priority: 'high',
			dueAt: '2026-08-05T10:00:00.000Z'
		},
		{
			id: 'T-1002',
			title: '整理课程截图',
			status: 'todo',
			priority: 'medium',
			dueAt: '2026-08-08T10:00:00.000Z'
		},
		{
			id: 'T-1003',
			title: '发布第四章代码',
			status: 'done',
			priority: 'low',
			dueAt: '2026-08-01T10:00:00.000Z'
		}
	]

	list(filters: TaskFilters = {}): TaskRecord[] {
		return this.tasks.filter((task) => {
			return !filters.status || task.status === filters.status
		})
	}
}
