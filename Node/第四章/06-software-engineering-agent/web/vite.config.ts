import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
	root: resolve(__dirname),
	plugins: [vue()],
	server: {
		port: 5178,
		strictPort: true,
		proxy: {
			'/api': 'http://127.0.0.1:4300'
		}
	},
	build: {
		outDir: resolve(__dirname, '../web-dist'),
		emptyOutDir: true
	}
})
