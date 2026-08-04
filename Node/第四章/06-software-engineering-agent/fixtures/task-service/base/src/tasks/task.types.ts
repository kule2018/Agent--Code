export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high'

export interface TaskRecord {
	id: string
	title: string
	status: TaskStatus
	priority: TaskPriority
	dueAt: string
}

export interface TaskFilters {
	status?: TaskStatus
}
