import { describe, expect, it } from 'vitest'
import { TaskService } from '../src/tasks/task.service'

describe('TaskService', () => {
	it('filters tasks by status', () => {
		const service = new TaskService()
		expect(service.list({ status: 'todo' })).toHaveLength(1)
	})

	it('filters tasks by priority', () => {
		const service = new TaskService()
		const result = service.list({ priority: 'high' })

		expect(result).toHaveLength(1)
		expect(result[0].id).toBe('T-1001')
	})
})
