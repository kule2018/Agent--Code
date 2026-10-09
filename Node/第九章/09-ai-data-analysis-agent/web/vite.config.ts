import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), plugins: [vue()], build: { outDir: '../dist/web', emptyOutDir: true }, server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT || 5187), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.PORT || 4317}`, '/voice': { target: `ws://127.0.0.1:${process.env.PORT || 4317}`, ws: true } } } })
