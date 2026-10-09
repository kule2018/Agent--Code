/** 校验服务端配置；ASR 和 TTS 共用同一地域、业务空间的 Key。 */
function configuration(env) {
	if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL) {
		throw new Error(
			'请在本节 .env 配置 DASHSCOPE_API_KEY 和 DASHSCOPE_BASE_URL。'
		)
	}
	const base = new URL(env.DASHSCOPE_BASE_URL)
	if (
		base.protocol !== 'https:' ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.port ||
		base.pathname.replace(/\/$/, '') !== '/compatible-mode/v1' ||
		!/^(?:dashscope(?:-intl)?\.aliyuncs\.com|[\w-]+\.(?:cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com)$/.test(
			base.hostname
		)
	) {
		throw new Error(
			'DASHSCOPE_BASE_URL 请使用百炼北京或新加坡地域的真实兼容接口地址，以 /compatible-mode/v1 结尾。'
		)
	}
	return {
		base: base.href.replace(/\/$/, ''),
		origin: base.origin,
		key: env.DASHSCOPE_API_KEY
	}
}

/** 只接受本例浏览器录制的 WebM 或 Ogg；上传大小在进入识别服务前限制。 */
export function validateAudio(audio, contentType) {
	const mime = contentType?.split(';')[0].trim().toLowerCase()
	if (
		!Buffer.isBuffer(audio) ||
		audio.length < 32 ||
		audio.length > 2 * 1024 * 1024
	) {
		throw new Error('录音为空或超过 2 MB，请重新录制一段不超过 30 秒的问题。')
	}
	const webm =
		mime === 'audio/webm' &&
		audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
	const ogg = mime === 'audio/ogg' && audio.subarray(0, 4).toString() === 'OggS'
	if (!webm && !ogg)
		throw new Error('录音格式需要是 WebM 或 Ogg，请使用新版 Chrome / Edge。')
	return mime
}

/** 调用语音服务；超时和供应商错误交给页面显示，不伪造识别或合成结果。 */
async function postJSON(url, body, key, fetchImpl) {
	const response = await fetchImpl(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${key}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
		redirect: 'error'
	})
	const data = await response.json()
	if (!response.ok || data.code) {
		throw new Error(
			`语音服务 ${response.status}：${data.message || data.error?.message || data.code || '请求失败'}`
		)
	}
	return data
}

/** 将一段完整录音转换为文字；不在此处执行分析。 */
export async function transcribe(
	audio,
	contentType,
	{ env = process.env, fetchImpl = fetch } = {}
) {
	// 校验音频数据和格式，返回符合要求的 MIME 类型
	const mime = validateAudio(audio, contentType)

	// 读取语音识别服务的接口地址和 API Key
	const { base, key } = configuration(env)

	// 调用通义千问 ASR 模型，将完整录音转换为文字
	const response = await postJSON(
		`${base}/chat/completions`,
		{
			model: 'qwen3-asr-flash',
			messages: [
				{
					role: 'user',
					// 将音频转为 Base64，并拼接为模型要求的 Data URL 格式
					content: [
						{
							type: 'input_audio',
							input_audio: {
								data: `data:${mime};base64,${audio.toString('base64')}`
							}
						}
					]
				}
			],
			// 关闭流式输出，等待模型返回完整识别结果
			stream: false,
			// 关闭逆文本正则化（ITN），不主动将口语中的数字等转换为规范格式
			asr_options: { enable_itn: false }
		},
		key,
		fetchImpl
	)

	// 从模型响应中提取识别出的文字
	const text = response.choices?.[0]?.message?.content

	// 检查识别结果是否为有效的非空字符串
	if (typeof text !== 'string' || !text.trim())
		throw new Error('没有识别到文字，请重新录音或直接输入问题。')

	// 限制识别文字长度，避免过长内容进入后续 Agent 分析流程
	if (text.length > 2000) throw new Error('识别文字过长，请缩短问题。')

	// 去除首尾空白，返回识别文字，交由用户核对
	return text.trim()
}

/**
 * 将已生成的短回答合成为音频，返回供应商提供的临时播放地址。
 */
export async function synthesize(
	text,
	{ env = process.env, fetchImpl = fetch } = {}
) {
	// 校验朗读文本：必须是非空字符串，且长度不能超过 600 个 Unicode 字符
	if (typeof text !== 'string' || !text.trim() || [...text].length > 600) {
		throw new Error('本例每次合成 1 到 600 字符的回答。')
	}

	// 读取语音合成服务的接口地址和 API Key
	const { origin, key } = configuration(env)

	// 调用通义千问 TTS 模型，将文本合成为中文语音
	const response = await postJSON(
		`${origin}/api/v1/services/aigc/multimodal-generation/generation`,
		{
			model: 'qwen3-tts-flash',
			// 指定朗读文本、音色和语言
			input: { text, voice: 'Cherry', language_type: 'Chinese' }
		},
		key,
		fetchImpl
	)

	// 从模型响应中提取生成的音频播放地址
	const rawURL = response.output?.audio?.url

	// 如果服务没有返回音频地址，则终止本次合成
	if (!rawURL) throw new Error('语音服务没有返回音频地址。')

	// 解析音频地址，准备进行安全校验
	const url = new URL(rawURL)

	// 限制音频地址必须使用 HTTP/HTTPS，且属于预期的阿里云 OSS 域名
	// 同时拒绝包含用户名、密码或自定义端口的地址
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.port ||
		!/\.oss-[a-z0-9-]+\.aliyuncs\.com$/.test(url.hostname)
	) {
		throw new Error('语音服务返回了非预期音频地址。')
	}

	// 官方示例可能返回 HTTP 的 OSS URL；使用同一地址的 HTTPS 版本播放。
	url.protocol = 'https:'

	// 返回经过校验的音频地址，交给浏览器播放
	return url.href
}
