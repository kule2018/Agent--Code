import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  root: 'web', plugins: [vue()],
  server: {
    host: '127.0.0.1', port: Number(process.env.WEB_PORT || 5186), strictPort: true,
    proxy: { '/voice': { target: `ws://127.0.0.1:${process.env.PORT || 4316}`, ws: true },
      '/api': `http://127.0.0.1:${process.env.PORT || 4316}` }
  },
  build: { outDir: '../dist/web', emptyOutDir: true }
})
