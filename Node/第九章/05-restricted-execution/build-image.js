import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

export const projectDir = dirname(fileURLToPath(import.meta.url))
export const imageName = 'agent-course-analysis:chapter9-05'

/** 只打包固定运行器与锁定依赖，不把宿主代码、数据目录和配置文件发送到镜像构建上下文。 */
export async function buildImage() {
  await mkdir(join(projectDir, '.work'), { recursive: true })
  const context = await mkdtemp(join(projectDir, '.work', 'build-'))
  try {
    for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'entry.js']) {
      await copyFile(join(projectDir, 'runtime', name), join(context, name))
    }
    // 复用上一节已经验证过的 SQL 解析和只读查询实现。
    await copyFile(join(projectDir, '../04-text-to-sql/query-worker.js'), join(context, 'query-worker.js'))
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['build', '--tag', imageName, context], { stdio: 'inherit' })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`镜像构建失败，退出码 ${code}`)))
    })
  } finally {
    await rm(context, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildImage().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
