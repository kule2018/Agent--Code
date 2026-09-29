import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  server: { port: 5183, proxy: { '/api': 'http://127.0.0.1:4311' } },
  build: { outDir: '../dist/web', emptyOutDir: true }
})
