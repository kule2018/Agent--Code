import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'web',
  envDir: false,
  plugins: [vue()],
  server: { port: 5184, strictPort: true, proxy: { '/api': process.env.STORY_BASE_URL ?? 'http://127.0.0.1:4312' } },
  build: { outDir: '../dist/web', emptyOutDir: true }
})
