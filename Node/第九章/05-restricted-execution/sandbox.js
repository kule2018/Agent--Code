import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, copyFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectDir, imageName } from './build-image.js'

const execFileAsync = promisify(execFile)
const outputLimit = 64 * 1024
const jobRoot = join(projectDir, '.work', 'jobs')

/**
 * Docker 参数全部由应用构造，不接受模型提供镜像、挂载目录或资源配置。
 */
export function containerArgs(name, inputDirectory) {
	// Docker 的 --mount 参数使用逗号分隔配置项，禁止路径包含逗号，避免解析错误
	if (inputDirectory.includes(','))
		throw new Error('本课挂载路径不能包含英文逗号。')

	// 构造 Docker 容器创建参数，统一限制网络、文件权限和资源使用
	return [
		'create',
		'--name',
		name, // 为本次任务指定独立的容器名称
		'--label',
		'agent-course=chapter9-05', // 添加课程标签，方便识别和管理容器

		// 网络隔离：禁止容器访问外部网络
		'--network',
		'none',

		// 文件系统隔离：将容器根文件系统设置为只读
		'--read-only',

		// 使用非 root 用户运行容器，降低执行代码的权限
		'--user',
		'1000:1000',

		// 移除 Linux Capabilities，禁止获取额外的系统操作权限
		'--cap-drop',
		'ALL',

		// 禁止容器进程通过提权机制获得新的权限
		'--security-opt',
		'no-new-privileges=true',

		// 资源限制：最多使用 1 个 CPU
		'--cpus',
		'1',

		// 内存限制：最多使用 256 MiB
		'--memory',
		'256m',

		// 内存与 Swap 总量同样限制为 256 MiB，避免通过 Swap 绕过内存限制
		'--memory-swap',
		'256m',

		// 限制容器内最多创建 64 个进程或线程，防止大量创建进程
		'--pids-limit',
		'64',

		// 启用轻量级 init 进程，负责回收僵尸进程和转发终止信号
		'--init',

		// 禁用 Docker 日志驱动，避免容器输出持续占用宿主磁盘
		'--log-driver',
		'none',

		// 提供 16 MiB 的临时可写目录，禁止执行其中的文件和使用特殊权限
		'--tmpfs',
		'/tmp:rw,noexec,nosuid,size=16m,mode=1777',

		// 只挂载本次任务的输入目录，并设置为只读
		// 容器只能通过 /input 读取授权数据，无法修改挂载文件
		'--mount',
		`type=bind,source=${inputDirectory},target=/input,readonly`,

		// 使用应用预先指定的镜像，不允许模型自行选择镜像
		imageName
	]
}

/** 有界调用 Docker 管理命令；不通过 Shell 拼接执行模型输出。 */
export async function docker(args) {
	const { stdout } = await execFileAsync('docker', args, {
		timeout: 15_000,
		maxBuffer: 1024 * 1024
	})
	return stdout.trim()
}

/** 收集执行输出；超时或输出超量时删除整个容器，而不只停止 docker 客户端。 */
async function startAndCollect(name, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['start', '--attach', name], {
			stdio: ['ignore', 'pipe', 'pipe']
		})
		let stdout = ''
		let stderr = ''
		let bytes = 0
		let stopped
		let removal
		const stop = (status) => {
			if (stopped) return
			stopped = status
			removal = docker(['rm', '--force', name]).then(
				() => null,
				(error) => error
			)
			// Docker 管理命令如果不可用，也要结束本地等待；finally 会再次尝试清理并明确报错。
			removal.then(() => child.kill('SIGKILL'))
		}
		const timer = setTimeout(() => stop('timeout'), timeoutMs)
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		const collect = (text, isError) => {
			bytes += Buffer.byteLength(text)
			if (bytes > outputLimit) return stop('output_limit')
			if (isError) stderr += text
			else stdout += text
		}
		child.stdout.on('data', (text) => collect(text, false))
		child.stderr.on('data', (text) => collect(text, true))
		child.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('close', async (exitCode) => {
			clearTimeout(timer)
			const cleanupError = await removal
			if (cleanupError)
				return reject(
					new Error(`容器停止失败：${name}；${cleanupError.message}`)
				)
			resolve({ stdout, stderr, exitCode, stopped })
		})
	})
}

/** 返回结构由宿主再次检查，格式正确仍不等于业务计算正确。 */
export function validateResult(result) {
	if (!result || !Array.isArray(result.rows) || result.rows.length > 100)
		throw new Error('结果必须包含至多 100 行的 rows。')
	if (result.truncated === true)
		throw new Error('查询结果被截断，请缩小查询范围后再分析。')
	for (const row of result.rows) {
		if (
			!row ||
			typeof row !== 'object' ||
			Array.isArray(row) ||
			Object.keys(row).length > 20
		)
			throw new Error('结果行结构错误。')
		for (const [key, value] of Object.entries(row)) {
			if (
				key.length > 64 ||
				!(
					value === null ||
					typeof value === 'boolean' ||
					(typeof value === 'number' && Number.isFinite(value)) ||
					(typeof value === 'string' && value.length <= 1000)
				)
			) {
				throw new Error('结果字段超出允许的类型或长度。')
			}
		}
	}
	return { rows: result.rows }
}

/**
 * 每次任务创建新容器，只暴露此次输入；databasePath 来自应用已选定的数据集。
 */
export async function runSandbox(
	task,
	{ databasePath, timeoutMs = 5000 } = {}
) {
	// 校验执行时限，防止任务无限运行或设置不合理的超时时间
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
		throw new Error('执行时限必须为 100 至 30000 毫秒。')

	// 根据任务类型校验输入，只接受 SQL 查询或分析代码
	if (task.kind === 'sql') {
		// SQL 任务必须提供数据库路径，并限制 SQL 文本长度
		if (
			!databasePath ||
			typeof task.sql !== 'string' ||
			task.sql.length > 12_000
		)
			throw new Error('SQL 任务参数无效。')
	} else if (task.kind === 'code') {
		// 代码任务限制代码大小，避免传入过大的执行内容
		if (
			typeof task.code !== 'string' ||
			Buffer.byteLength(task.code) > 16 * 1024
		)
			throw new Error('分析代码过长或格式错误。')

		// 校验输入数据结构，并将序列化后的数据限制在 64 KiB 以内
		validateResult({ rows: task.rows })
		if (Buffer.byteLength(JSON.stringify(task.rows)) > outputLimit)
			throw new Error('输入数据超过 64 KiB。')
	} else throw new Error('只允许 sql 或 code 任务。')

	// 为本次任务生成唯一标识，避免不同任务之间发生资源冲突
	const jobId = randomUUID()
	const name = `course-analysis-${jobId}`

	// 每次任务使用独立的临时输入目录
	const inputDirectory = join(jobRoot, jobId, 'input')
	const started = Date.now()
	let report
	let created = false

	try {
		// 创建输入目录，准备本次容器需要读取的文件
		await mkdir(inputDirectory, { recursive: true })

		// 生成任务描述：SQL 任务传入查询语句，代码任务只声明类型
		const request =
			task.kind === 'sql' ? { kind: 'sql', sql: task.sql } : { kind: 'code' }

		// 将任务描述写入只读文件，供容器内部程序读取
		await writeFile(
			join(inputDirectory, 'request.json'),
			JSON.stringify(request),
			{ mode: 0o444 }
		)

		if (task.kind === 'sql') {
			// SQL 任务：复制本次授权的数据集，不直接挂载原始数据库文件
			await copyFile(databasePath, join(inputDirectory, 'data.duckdb'))

			// 将数据库副本设置为只读，禁止容器修改输入数据
			await chmod(join(inputDirectory, 'data.duckdb'), 0o444)
		} else {
			// 代码任务：将有限的查询结果写入容器输入文件
			await writeFile(
				join(inputDirectory, 'rows.json'),
				JSON.stringify(task.rows),
				{ mode: 0o444 }
			)

			// 将待执行的分析代码单独保存，并设置为只读
			await writeFile(join(inputDirectory, 'analysis.mjs'), task.code, {
				mode: 0o444
			})
		}

		// 输入目录只允许读取和进入，不允许新增、删除或修改文件
		await chmod(inputDirectory, 0o555)

		// 创建独立容器；提前标记，确保创建异常时也尝试清理
		created = true
		await docker(containerArgs(name, inputDirectory))

		// 读取容器实际配置，记录网络、文件系统和资源限制
		const [details] = JSON.parse(await docker(['inspect', name]))
		const execution = {
			network: details.HostConfig.NetworkMode,
			readOnly: details.HostConfig.ReadonlyRootfs,
			memoryBytes: details.HostConfig.Memory,
			nanoCpus: details.HostConfig.NanoCpus,
			user: details.Config.User,
			pidsLimit: details.HostConfig.PidsLimit,

			// 记录容器挂载目录及其是否允许写入
			mounts: details.Mounts.map(({ Destination, RW }) => ({
				destination: Destination,
				writable: RW
			}))
		}

		// 启动容器并收集输出，同时监控执行超时和输出大小
		const output = await startAndCollect(name, timeoutMs)

		if (output.stopped) {
			// 超时或输出超限时，记录容器被终止的原因
			report = {
				status: output.stopped,
				error:
					output.stopped === 'timeout'
						? '超过执行时限，容器已终止。'
						: '输出超过 64 KiB，容器已终止。'
			}
		} else {
			// 容器正常退出后，检查是否因为超过内存限制而被系统终止
			const [finished] = JSON.parse(await docker(['inspect', name]))

			if (finished.State.OOMKilled) {
				report = { status: 'resource_limit', error: '容器触及内存限制。' }
			} else {
				try {
					// 解析容器输出，要求符合约定的 JSON 响应格式
					const message = JSON.parse(output.stdout)

					if (output.exitCode !== 0 || message.ok !== true) {
						// 执行失败时提取错误信息，并截断过长的错误内容
						const error =
							typeof message.error === 'string'
								? message.error.slice(0, 1600)
								: '执行失败。'

						// 区分安全策略拒绝和普通执行失败
						report = {
							status: error.startsWith('POLICY:') ? 'rejected' : 'failed',
							error
						}
					} else {
						// 执行成功后再次校验返回结果，避免接受不符合约定的数据
						report = {
							status: 'completed',
							result: validateResult(message.result)
						}
					}
				} catch (error) {
					// JSON 解析失败或结果校验不通过，统一标记为无效结果
					report = {
						status: 'invalid_result',
						error: `未返回约定的 JSON 表格：${error.message}`
					}
				}
			}
		}

		// 汇总任务标识、执行结果、容器配置和执行耗时
		report = {
			jobId,
			containerName: name,
			kind: task.kind,
			...report,
			execution,
			elapsedMs: Date.now() - started
		}
	} finally {
		// 无论任务成功、失败还是超时，都进入资源清理流程
		// 超时分支可能已删除容器；其余路径在这里统一删除。清理失败不能宣称任务已安全结束。
		if (created) {
			// 检查本次任务对应的容器是否仍然存在
			const existing = await docker([
				'ps',
				'--all',
				'--quiet',
				'--filter',
				`name=^/${name}$`
			])

			// 如果容器仍然存在，则强制删除，避免残留运行资源
			if (existing) await docker(['rm', '--force', name])
		}

		// 恢复输入目录权限，确保宿主程序能够删除临时文件
		await chmod(inputDirectory, 0o755).catch(() => {})

		// 删除本次任务的临时目录，包括数据库副本、输入数据和分析代码
		await rm(join(jobRoot, jobId), { recursive: true, force: true })
	}

	// 清理成功后，返回完整执行报告并标记资源已清理
	return { ...report, cleanedUp: true }
}
