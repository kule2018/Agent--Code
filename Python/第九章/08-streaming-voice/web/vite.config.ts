import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.WEB_PORT || 5186)
const proxy = {
  '/voice': { target: `ws://127.0.0.1:${process.env.PORT || 4316}`, ws: true },
  '/api': `http://127.0.0.1:${process.env.PORT || 4316}`
}

export default defineConfig({
  // 文件位置决定资源根目录，不依赖 npm 启动时的 cwd。
  root: fileURLToPath(new URL('.', import.meta.url)),
  // 不让 Vite 自动读取任何环境文件；端口只来自用户已导出的进程变量。
  envDir: false,
  plugins: [vue()],
  server: { host: '127.0.0.1', port, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port, strictPort: true, proxy },
  build: { outDir: '../dist/web', emptyOutDir: true }
})
