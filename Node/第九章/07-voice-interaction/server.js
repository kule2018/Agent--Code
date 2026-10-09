import express from 'express'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { transcribe, synthesize } from './speech.js'
import { analyze } from './analysis.js'

const root = dirname(fileURLToPath(import.meta.url))

/** 创建 Express 应用：提供语音转写、Agent 分析和语音合成接口。 */
export function createApp(services = { transcribe, analyze, synthesize }) {
	const app = express()

	// 临时保存 Agent 生成的回答，供后续 TTS 语音合成使用
	const answers = new Map()

	// 全局请求锁：避免多个 API 请求同时执行
	let busy = false

	// 隐藏 Express 标识，减少服务端框架信息暴露
	app.disable('x-powered-by')

	// 统一进行本机访问限制和安全响应头设置
	app.use((req, res, next) => {
		// 只允许通过 localhost 或 127.0.0.1 访问
		if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
			return res.status(403).json({ error: '只接受本机访问。' })
		}

		// 如果携带 Origin，则必须与当前服务地址一致，防止其他网站跨站调用
		if (
			req.headers.origin &&
			req.headers.origin !== `http://${req.headers.host}`
		) {
			return res.status(403).json({ error: '不接受其他网站发起的请求。' })
		}

		// 设置安全响应头：防止 MIME 嗅探、限制来源信息、禁止缓存和限制页面资源
		res.set('X-Content-Type-Options', 'nosniff')
		res.set('Referrer-Policy', 'no-referrer')
		res.set('Cache-Control', 'no-store')
		res.set(
			'Content-Security-Policy',
			"default-src 'self'; style-src 'self'; media-src 'self' https://*.aliyuncs.com; object-src 'none'; frame-ancestors 'none'"
		)
		next()
	})

	// 解析 JSON 请求体，最大允许 16KB
	app.use(express.json({ limit: '16kb' }))

	// 接收浏览器上传的原始音频数据，最大允许 2MB
	app.use(express.raw({ type: ['audio/webm', 'audio/ogg'], limit: '2mb' }))

	// 忽略浏览器自动请求的 favicon
	app.get('/favicon.ico', (_req, res) => res.status(204).end())

	// 提供 Lucide 图标库的本地静态文件
	app.get('/vendor/lucide.js', (_req, res) =>
		res.sendFile(join(root, 'node_modules/lucide/dist/umd/lucide.js'))
	)

	// 托管前端页面及其他静态资源
	app.use(express.static(join(root, 'public')))

	// 本节每次只运行一个请求，避免重复点击触发并发计费。
	app.use('/api', (_req, res, next) => {
		// 如果已有 API 请求正在处理，则拒绝新的请求
		if (busy)
			return res.status(409).json({ error: '上一次请求仍在处理，请稍后再试。' })

		// 获取请求锁，并提供释放锁的方法
		busy = true
		res.locals.release = () => {
			busy = false
		}
		next()
	})

	/** ASR 接口：接收完整录音，将语音转换为文字。 */
	app.post('/api/transcribe', async (req, res, next) => {
		try {
			// 将音频数据和格式交给语音识别服务
			const text = await services.transcribe(
				req.body,
				req.headers['content-type']
			)

			// 将识别出的文字返回浏览器
			res.json({ text })
		} catch (error) {
			next(error)
		} finally {
			// 无论识别成功还是失败，都释放请求锁
			res.locals.release()
		}
	})

	/** Agent 分析接口：处理用户问题，生成回答并保存待朗读文本。 */
	app.post('/api/ask', async (req, res, next) => {
		try {
			// 从 JSON 请求体中读取用户确认后的问题
			const question = req.body?.question

			// 检查问题是否为非空字符串，且长度不超过 2000 字符
			if (
				typeof question !== 'string' ||
				!question.trim() ||
				question.length > 2000
			) {
				return res.status(400).json({ error: '请输入 1 到 2000 字符的问题。' })
			}

			// 调用 Agent 分析问题，生成回答结果
			const result = await services.analyze(question.trim())

			// 为本次回答生成唯一 ID，供后续 TTS 请求引用
			const answerId = randomUUID()

			// 清理已经超过有效期的历史回答
			for (const [id, entry] of answers)
				if (entry.expiresAt <= Date.now()) answers.delete(id)

			// 最多保存 10 条回答，超过限制时删除最早保存的一条
			if (answers.size >= 10) answers.delete(answers.keys().next().value)

			// 保存待朗读文本，有效期为 15 分钟
			answers.set(answerId, {
				text: result.speechText,
				expiresAt: Date.now() + 15 * 60_000
			})

			// 返回 Agent 分析结果和 answerId，供浏览器展示及请求语音
			res.json({ ...result, answerId })
		} catch (error) {
			next(error)
		} finally {
			// 释放请求锁
			res.locals.release()
		}
	})

	/** TTS 接口：根据 answerId，将已生成的回答转换为语音。 */
	app.post('/api/speak', async (req, res, next) => {
		try {
			// 根据浏览器提交的 answerId 查找待朗读文本
			const entry = answers.get(req.body?.answerId)

			// 如果回答不存在或已过期，要求用户重新分析
			if (!entry || entry.expiresAt <= Date.now()) {
				return res
					.status(410)
					.json({ error: '本次回答已过期或服务已重启，请重新分析。' })
			}

			// 只合成本服务已经生成的回答，不接收浏览器任意指定的朗读文本。
			// 如果此前已经合成过，则直接复用音频地址，避免重复调用 TTS
			entry.audioUrl ||= await services.synthesize(entry.text)

			// 将合成后的音频地址返回浏览器
			res.json({ audioUrl: entry.audioUrl })
		} catch (error) {
			next(error)
		} finally {
			// 释放请求锁
			res.locals.release()
		}
	})

	// 处理不存在的 API 路径
	app.use('/api', (_req, res) => {
		res.locals.release?.()
		res.status(404).json({ error: '接口不存在。' })
	})

	// 统一错误处理：区分上传内容过大和其他服务端错误
	app.use((error, _req, res, _next) => {
		res.status(error.status === 413 ? 413 : 500).json({
			error: error.status === 413 ? '上传内容过大，请缩短录音。' : error.message
		})
	})

	// 返回配置完成的 Express 应用
	return app
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const port = Number(process.env.PORT || 5185)
	const server = createApp().listen(port, '127.0.0.1', () => {
		console.log(`语音分析页面：http://localhost:${port}`)
		console.log(
			'真实转写、分析、合成会调用云端 API。请先配置本节 .env；密钥只在服务端使用。'
		)
	})
	server.on('error', (error) => {
		console.error(
			error.code === 'EADDRINUSE'
				? `端口 ${port} 已被占用，请用 PORT=其他端口 npm run dev 启动。`
				: error.message
		)
		process.exitCode = 1
	})
}
