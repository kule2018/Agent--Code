import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const child = spawn('docker', ['build', '-t', 'agent-course-analysis:chapter9-09', fileURLToPath(new URL('../runtime', import.meta.url))], { stdio: 'inherit' })
child.on('error', error => { console.error('请启动 Docker Desktop：', error.message); process.exitCode = 1 })
child.on('close', code => { process.exitCode = code || 0 })
