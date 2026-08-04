import { Inject, Injectable } from '@nestjs/common'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { WorkspaceService } from './workspace.service'

const execFileAsync = promisify(execFile)

export interface CommandResult {
	command: string
	passed: boolean
	exitCode: number
	stdout: string
	stderr: string
	durationMs: number
}

@Injectable()
export class CommandService {
	constructor(
		@Inject(WorkspaceService)
		private readonly workspaces: WorkspaceService
	) {}

	async runTests(runId: string): Promise<CommandResult> {
		const vitest = resolve(
			this.workspaces.projectRoot,
			'node_modules/vitest/vitest.mjs'
		)
		return this.execute(
			process.execPath,
			[
				vitest,
				'run',
				'--config',
				resolve(this.workspaces.projectRoot, 'fixture.vitest.config.mts'),
				'--root',
				this.workspaces.getWorkspacePath(runId),
				'--reporter=default'
			],
			'test'
		)
	}

	async runTypecheck(runId: string): Promise<CommandResult> {
		const tsc = resolve(
			this.workspaces.projectRoot,
			'node_modules/typescript/bin/tsc'
		)
		return this.execute(
			process.execPath,
			[tsc, '-p', this.workspaces.resolveSafePath(runId, 'tsconfig.json')],
			'typecheck'
		)
	}

	async runBuild(runId: string): Promise<CommandResult> {
		const tsc = resolve(
			this.workspaces.projectRoot,
			'node_modules/typescript/bin/tsc'
		)
		return this.execute(
			process.execPath,
			[
				tsc,
				'-p',
				this.workspaces.resolveSafePath(runId, 'tsconfig.json'),
				'--noEmit',
				'false',
				'--outDir',
				this.workspaces.resolveSafePath(runId, '.agent/build')
			],
			'build'
		)
	}

	async runLint(runId: string): Promise<CommandResult> {
		const startedAt = Date.now()
		const files = (await this.workspaces.listFiles(runId)).filter((path) =>
			/\.(ts|tsx)$/.test(path)
		)
		const issues: string[] = []

		for (const path of files) {
			const content = await this.workspaces.read(runId, path)
			content.split('\n').forEach((line, index) => {
				if (/\s+$/.test(line)) {
					issues.push(`${path}:${index + 1} 存在行尾空格`)
				}
			})
		}

		return {
			command: 'lint',
			passed: issues.length === 0,
			exitCode: issues.length === 0 ? 0 : 1,
			stdout: issues.length === 0 ? `已检查 ${files.length} 个文件。` : '',
			stderr: issues.join('\n'),
			durationMs: Date.now() - startedAt
		}
	}

	private async execute(
		file: string,
		args: string[],
		label: string
	): Promise<CommandResult> {
		const startedAt = Date.now()

		try {
			const result = await execFileAsync(file, args, {
				cwd: this.workspaces.projectRoot,
				timeout: 20_000,
				maxBuffer: 1_000_000,
				env: { ...process.env, FORCE_COLOR: '0' }
			})

			return {
				command: label,
				passed: true,
				exitCode: 0,
				stdout: clip(result.stdout),
				stderr: clip(result.stderr),
				durationMs: Date.now() - startedAt
			}
		} catch (error) {
			const value = error as {
				code?: number | string
				stdout?: string
				stderr?: string
				message?: string
			}

			return {
				command: label,
				passed: false,
				exitCode: typeof value.code === 'number' ? value.code : 1,
				stdout: clip(value.stdout ?? ''),
				stderr: clip(value.stderr || value.message || '命令执行失败。'),
				durationMs: Date.now() - startedAt
			}
		}
	}
}

function clip(value: string): string {
	return value.length > 12_000 ? `${value.slice(0, 12_000)}\n...输出已截断` : value
}
