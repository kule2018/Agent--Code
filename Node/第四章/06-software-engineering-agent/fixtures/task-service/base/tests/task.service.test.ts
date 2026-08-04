import { describe, expect, it } from 'vitest'
import { TaskService } from '../src/tasks/task.service'

describe('TaskService', () => {
	it('filters tasks by status', () => {
		const service = new TaskService()
		const result = service.list({ status: 'todo' })

		expect(result).toHaveLength(1)
		expect(result[0].id).toBe('T-1002')
	})
})
