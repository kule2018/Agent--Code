import type { TaskRecord } from './task.types'

/** 判断一条未完成任务是否已经超过截止时间。 */
export function isTaskOverdue(task: TaskRecord, now: Date): boolean {
	return task.status !== 'done' && new Date(task.dueAt).getTime() <= now.getTime()
}
