import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 在独立进程执行查询，超时终止；不继承主进程中的 API Key 或 --env-file 参数。 */
export function executeQuery(databasePath, sql, { timeoutMs = 5000, maxRows = 100 } = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100) throw new Error('maxRows 必须在 1 到 100 之间。')
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./query-worker.js', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
    })
    let output = ''
    let stderr = ''
    let failure
    const fail = (message) => {
      failure ??= new Error(message)
      worker.kill('SIGKILL')
    }
    const timer = setTimeout(() => fail('查询超时，已终止，不自动重试。'), timeoutMs)
    worker.stdout.setEncoding('utf8')
    worker.stderr.setEncoding('utf8')
    worker.stdout.on('data', (chunk) => {
      output += chunk
      if (Buffer.byteLength(output) > 64 * 1024) fail('查询结果超过 64 KiB，请缩小查询范围。')
    })
    worker.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    worker.stdin.on('error', () => {})
    worker.on('error', (error) => { failure = error })
    worker.on('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      if (code !== 0) return reject(new Error(`查询进程异常：${stderr || code}`))
      try {
        const result = JSON.parse(output)
        if (!result.ok) return reject(Object.assign(new Error(result.message), { repairable: result.repairable }))
        resolve({ rows: result.rows, truncated: result.truncated })
      } catch (error) { reject(error) }
    })
    worker.stdin.end(JSON.stringify({ databasePath, sql, maxRows }))
  })
}
