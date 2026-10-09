import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, copyFile, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { root } from './storage.js'
import type { Row } from '../shared/types.js'

const exec = promisify(execFile)
export const image = 'agent-course-analysis:chapter9-09'

/** 为一次查询复制授权数据库，创建无网络、只读且有资源上限的临时容器。 */
export async function executeQuery(databasePath: string, sql: string, signal: AbortSignal, timeoutMs = 10000): Promise<Row[]> {
  signal.throwIfAborted()
  if (!sql.trim() || sql.length > 12000) throw new Error('查询为空或过长')
  if (root.includes(',')) throw new Error('项目路径不能包含英文逗号')
  await mkdir(join(root, '.work'), { recursive: true })
  const directory = await mkdtemp(join(root, '.work', 'query-'))
  const name = `analysis-${randomUUID()}`
  let created = false
  const remove = () => exec('docker', ['rm', '--force', name], { timeout: 15000 }).catch(error => { if (/No such container/.test(error.stderr || '')) return null; throw error })
  try {
    await copyFile(databasePath, join(directory, 'data.duckdb'))
    await chmod(join(directory, 'data.duckdb'), 0o444)
    await writeFile(join(directory, 'request.json'), JSON.stringify({ sql }), { mode: 0o444 })
    signal.throwIfAborted()
    await exec('docker', ['create', '--name', name, '--label', 'agent-course=chapter9-09', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--cpus', '1', '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '64', '--init', '--log-driver', 'none', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m,mode=1777', '--mount', `type=bind,source=${directory},target=/input,readonly`, image], { timeout: 20000 })
    created = true
    signal.throwIfAborted()
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', name], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = '', size = 0, stopped: Error | undefined
      const stop = (error: Error) => { if (stopped) return; stopped = error; void remove().catch(() => null).finally(() => child.kill('SIGKILL')) }
      const abort = () => stop(signal.reason)
      const timer = setTimeout(() => stop(new Error('查询超过 10 秒，已停止')), timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 256 * 1024) stop(new Error('查询输出过大')); else stdout += chunk })
      child.stderr.on('data', (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 256 * 1024) stop(new Error('查询输出过大')); else stderr += chunk })
      const clean = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      child.on('error', error => { clean(); reject(error) })
      child.on('close', () => { clean(); if (stopped) reject(stopped); else if (!stdout) reject(new Error(stderr || '查询没有返回结果')); else resolve(stdout) })
    })
    signal.throwIfAborted()
    const result = JSON.parse(output)
    if (!result.ok) throw new Error(result.message)
    if (result.truncated) throw new Error('结果超过 100 行，请缩小范围或先汇总')
    if (!Array.isArray(result.rows) || result.rows.length > 100) throw new Error('查询返回结构异常')
    return result.rows
  } catch (error) {
    if ((error as Error).message.includes('No such image')) throw new Error('缺少运行镜像，请先执行 npm run build:sandbox')
    throw error
  } finally {
    try { if (created) await remove() } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
