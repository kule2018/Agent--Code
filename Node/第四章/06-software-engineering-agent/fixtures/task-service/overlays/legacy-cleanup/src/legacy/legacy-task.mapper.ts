/**
 * 已经被 TaskService 替代的旧映射器。
 * 当前项目没有任何模块继续引用这个文件。
 */
export function mapLegacyTask(input: { task_name: string }) {
	return { title: input.task_name }
}
