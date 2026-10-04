import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 等待后端完成数据库初始化并能响应请求，再启动前端开发服务器。 */
export async function waitForApi(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(1000, deadline - Date.now()))
      })
      await response.body?.cancel()
      if (response.ok) return
    } catch {
      // 后端仍在加载依赖或初始化数据库，稍后再次检查。
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) await delay(Math.min(300, remaining))
  }
  throw new Error(`后端 API 在 ${timeoutMs / 1000} 秒内没有就绪：${url}。请查看 [server] 日志，并在项目目录执行 docker compose ps 确认 PostgreSQL 状态。`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('等待后端 API 完成初始化：http://127.0.0.1:4311')
  try {
    await waitForApi('http://127.0.0.1:4311/api/projects/meta')
    console.log('后端 API 已就绪，正在启动前端。')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
