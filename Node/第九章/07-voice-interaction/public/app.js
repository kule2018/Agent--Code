const $ = (id) => document.getElementById(id)
let busy = false
let recording = false
let recorder
let stream
let timer
let answerId
let audioUrl

/** 同一时间只处理一次录音或请求，文字入口始终与语音共用同一份 question。 */
function updateControls() {
	$('record').disabled = busy && !recording
	$('record').classList.toggle('recording', recording)
	$('record').querySelector('span').textContent = recording
		? '结束录音'
		: '开始录音'
	$('question').disabled = busy
	$('example').disabled = busy
	$('ask').disabled = busy || !$('question').value.trim()
	$('speak').disabled = busy || !answerId
}

function status(text, error = false) {
	$('status').textContent = text
	$('status').classList.toggle('error', error)
}

function stage(name) {
	for (const item of ['record', 'ask', 'speak'])
		$('step-' + item).classList.toggle('active', item === name)
}

/** 发起有时限的请求；错误只更新状态，不清除已经得到的分析结果。 */
async function request(path, options, timeout = 70_000) {
	const response = await fetch(path, {
		...options,
		signal: AbortSignal.timeout(timeout)
	})
	const data = await response.json()
	if (!response.ok) throw new Error(data.error || '请求失败')
	return data
}

function jsonRequest(path, data, timeout) {
	return request(
		path,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data)
		},
		timeout
	)
}

/** 开始新问题时停止旧音频，并清除旧回答的绑定，避免朗读错位。 */
function clearAnswer() {
	$('player').pause()
	$('player').removeAttribute('src')
	$('player').load()
	$('player').hidden = true
	$('result').hidden = true
	answerId = undefined
	audioUrl = undefined
}

function releaseMicrophone() {
	clearInterval(timer)
	stream?.getTracks().forEach((track) => track.stop())
	stream = undefined
}

/** 点击开始录音：申请麦克风并收集音频块；结束后才上传完整录音。 */
async function startRecording() {
	// 检查浏览器是否支持麦克风访问和录音功能
	if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
		status(
			'当前浏览器无法录音，请使用 localhost 上的新版 Chrome / Edge，或直接输入文字。',
			true
		)
		return
	}

	// 从候选格式中选择浏览器支持的音频编码格式
	const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'].find(
		(type) => MediaRecorder.isTypeSupported(type)
	)
	if (!mimeType)
		return status(
			'当前浏览器不支持本例的录音格式，请改用 Chrome / Edge 或输入文字。',
			true
		)

	// 清空上一次回答，锁定操作按钮，并切换到录音阶段
	clearAnswer()
	busy = true
	updateControls()
	stage('record')
	status('正在申请麦克风权限…')

	try {
		// 请求用户授权麦克风，获取音频流
		stream = await navigator.mediaDevices.getUserMedia({ audio: true })

		// 保存录音过程中产生的音频数据块
		const chunks = []

		// 创建录音器，指定音频格式和 64kbps 编码比特率
		recorder = new MediaRecorder(stream, {
			mimeType,
			audioBitsPerSecond: 64_000
		})

		let recordingError = false

		// 浏览器产生音频数据时，将非空数据块保存起来
		recorder.ondataavailable = (event) => {
			if (event.data.size) chunks.push(event.data)
		}

		// 录音发生错误时，释放麦克风并恢复界面状态
		recorder.onerror = () => {
			recordingError = true
			releaseMicrophone()
			recording = false
			busy = false
			updateControls()
			status('录音失败，请重新尝试或输入文字。', true)
		}

		// 录音停止后，将所有音频块合并并发送给 ASR 接口
		recorder.onstop = async () => {
			// 停止使用麦克风，更新录音状态
			releaseMicrophone()
			recording = false
			updateControls()

			// 如果录音过程已经失败，则不再执行语音识别
			if (recordingError) return

			$('record-status').textContent = '录音结束'
			status('正在识别语音…')

			try {
				// 将收集到的音频块合并为一个完整的音频文件
				const audio = new Blob(chunks, { type: mimeType })

				// 限制音频大小：至少 32 字节，最多 2MB
				if (audio.size < 32 || audio.size > 2 * 1024 * 1024)
					throw new Error('录音为空或过大，请重新录制。')

				// 上传完整音频，由服务端调用 ASR 完成语音转文字
				const { text } = await request('/api/transcribe', {
					method: 'POST',
					headers: { 'Content-Type': mimeType },
					body: audio
				})

				// 将识别结果填入问题输入框，等待用户核对
				$('question').value = text
				stage('ask')
				status('识别完成，请核对问题后点击“确认并分析”。')
			} catch (error) {
				// 处理音频校验失败或语音识别请求失败
				status(error.message, true)
			} finally {
				// 无论识别成功与否，都恢复按钮并聚焦输入框
				busy = false
				updateControls()
				$('question').focus()
			}
		}

		// 正式开始录音
		recorder.start()
		recording = true
		updateControls()

		// 启动录音计时器，最多允许录制 30 秒
		let seconds = 0
		$('record-status').textContent = '录音中 · 0 / 30 秒'
		status('正在录音…')

		timer = setInterval(() => {
			seconds++
			$('record-status').textContent = `录音中 · ${seconds} / 30 秒`

			// 到达 30 秒后自动停止录音，触发 onstop 处理音频
			if (seconds >= 30) stopRecording()
		}, 1000)
	} catch (error) {
		// 处理麦克风授权失败、设备不可用或录音初始化失败
		releaseMicrophone()
		busy = false
		recording = false
		updateControls()

		// 针对用户拒绝麦克风权限，显示更明确的提示
		status(
			error.name === 'NotAllowedError'
				? '麦克风未获授权。可以在浏览器中允许访问，或直接输入文字。'
				: error.message,
			true
		)
	}
}

/**
 * 停止录音：结束录制、释放麦克风，并更新界面状态。
 */
function stopRecording() {
	// 停止录音器，触发 onstop 回调处理已录制的音频
	if (recorder?.state === 'recording') recorder.stop()

	// 更新录音状态，释放麦克风资源
	recording = false
	releaseMicrophone()

	// 更新按钮状态
	updateControls()
}

/**
 * 点击确认并分析：只提交用户核对后的文本，按原有分析流程查询数据。
 */
async function submitQuestion() {
	// 获取用户核对后的问题，并去除首尾空白
	const question = $('question').value.trim()

	// 问题为空或已有任务正在执行时，不重复提交
	if (!question || busy) return

	// 清空上一次回答，锁定操作按钮，并切换到分析阶段
	clearAnswer()
	busy = true
	updateControls()
	stage('ask')
	status('正在分析并执行查询…')

	try {
		// 将确认后的问题提交给 Agent，最长等待 180 秒
		const result = await jsonRequest('/api/ask', { question }, 180_000)

		// 保存回答 ID，供后续 TTS 语音合成使用
		answerId = result.answerId

		// 展示 Agent 的回答、警告信息和数据查询依据
		$('answer').textContent = result.answer
		$('warning').textContent = result.warning
		$('metric').textContent = result.metric || '尚未执行查询'
		$('scope').textContent = result.scope || '待补充条件'
		$('version').textContent = `${result.datasetId} / ${result.version}`
		$('sql').textContent = result.sql || '本次没有生成可执行查询。'

		// 如果朗读文本与页面回答不同，则额外展示实际朗读内容
		$('speech-note').hidden = result.speechText === result.answer
		$('speech-note').textContent = `本次朗读：${result.speechText}`

		// 渲染数据库查询结果，并显示完整的分析结果区域
		renderRows(result.rows)
		$('result').hidden = false

		// 切换到语音播放阶段
		stage('speak')

		// 判断本次分析是否发生执行失败或回答生成失败
		const failed = ['failed', 'explanation_failed'].includes(result.status)

		// 根据分析状态展示不同提示：需要补充条件、执行失败或分析成功
		status(
			result.status === 'clarify'
				? '需要补充条件，请在问题中填写完整要求后再次提交。'
				: failed
					? '本次分析未完整完成。'
					: '分析完成。',
			failed
		)
	} catch (error) {
		// 处理请求超时、网络异常或服务端返回的错误
		status(error.message, true)
	} finally {
		// 无论分析成功还是失败，都解除操作锁定并恢复按钮状态
		busy = false
		updateControls()
	}
}

/** 使用 textContent 展示模型文字与数据库结果，避免把返回内容作为 HTML 执行。 */
function renderRows(rows) {
	$('rows').replaceChildren()
	$('rows-section').hidden = !rows.length
	if (!rows.length) return
	const columns = Object.keys(rows[0])
	const head = $('rows').createTHead().insertRow()
	for (const column of columns) {
		const th = document.createElement('th')
		th.textContent = column
		head.append(th)
	}
	const body = $('rows').createTBody()
	for (const row of rows) {
		const tr = body.insertRow()
		for (const column of columns)
			tr.insertCell().textContent =
				row[column] == null ? 'NULL' : String(row[column])
	}
}

/** 点击朗读回答：按回答 ID 合成一次音频，重复播放复用已经获得的地址。 */
async function speakAnswer() {
	if (!answerId || busy) return
	busy = true
	updateControls()
	status('正在准备回答音频…')
	try {
		if (!audioUrl)
			({ audioUrl } = await jsonRequest('/api/speak', { answerId }))
		$('player').src = audioUrl
		$('player').hidden = false
		try {
			await $('player').play()
			status('正在朗读回答。')
		} catch {
			status('音频已准备好，请点击播放器的播放按钮。')
		}
	} catch (error) {
		status(`朗读失败，文字结果仍可查看。${error.message}`, true)
	} finally {
		busy = false
		updateControls()
	}
}

$('record').addEventListener('click', () =>
	recording ? stopRecording() : startRecording()
)
$('ask').addEventListener('click', submitQuestion)
$('speak').addEventListener('click', speakAnswer)
$('question').addEventListener('input', () => {
	clearAnswer()
	updateControls()
	stage('ask')
})
$('example').addEventListener('click', () => {
	clearAnswer()
	$('question').value =
		'仅按已导入记录，2026 年 9 月各区域的未扣退款销售额分别是多少？'
	updateControls()
	stage('ask')
	$('question').focus()
})
$('player').addEventListener('ended', () => status('朗读结束。'))
$('player').addEventListener('error', () => {
	if (audioUrl)
		status('音频播放失败，可以重新分析后再合成；文字结果不受影响。', true)
})
window.addEventListener('pagehide', releaseMicrophone)
window.lucide.createIcons()
updateControls()
