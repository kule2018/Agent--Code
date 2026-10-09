# 08 流式语音与打断

NestJS + Vue 3 的最小语音实验。使用真实实时 ASR、DeepSeek 文本流和逐句 TTS，不提供 Replay 开关。录音与云端调用需自行配置密钥；测试使用假供应商，不产生调用费用。

## 运行

Node.js 22.20+。保留本章 03、04、05、07 相邻目录，先安装它们的依赖；已完成 07 则无需重复准备数据。

04 的 `npm run prepare-data` 和 05 的 `npm run build:sandbox` 需要先完成，查询期间保持 Docker Desktop 运行。

在本节目录配置 `.env`（仓库不提供或修改你的环境文件）：

```dotenv
DEEPSEEK_API_KEY=你的DeepSeekAPIKey
DEEPSEEK_MODEL=deepseek-flash
DASHSCOPE_API_KEY=你的百炼APIKey
DASHSCOPE_BASE_URL=https://你的真实业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

百炼的 Key、地域、业务空间须一致。也支持官方公共域名以及新加坡业务空间域名，请使用控制台提供的实际地址。

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5186 ，后端端口 4316。占用时关闭本例旧进程，或通过 shell 命令 `PORT=4317 WEB_PORT=5187 npm run dev` 同时指定两个端口。启动后修改代码或 .env 需要重启本例命令。

1. 点击开始录音，说完后结束录音。识别过程中可以看到预览，最终文字可以修改。
2. 确认并分析：执行真实 SQL，显示数据和流式回答，按句自动朗读。
3. 若浏览器阻止自动播放，点击继续播放。
4. 停止本轮，或者输入新问题再次分析；旧文字、旧音频不能继续进入新轮次。
5. 对比逐句返回和完整后返回，观察首段文字、音频就绪、首次播放、服务端完成时间。

每次提问都是独立任务；“只看华东”快捷项提供完整条件，不代表已实现跨轮指代消解或记忆。

## 范围

- ASR：qwen3-asr-flash-realtime，16kHz/PCM16/单声道。服务端 VAD 识别各句，应用按 item_id 累积文本；用户手动结束整段录音，30 秒上限。
- 浏览器到 NestJS：原生 WebSocket；服务端到 ASR：WebSocket；DeepSeek：SSE 增量。
- TTS：复用 07 的 qwen3-tts-flash，每个完整句子合成为一个 URL。属于句子级流水线，不是 PCM 音频帧推送。
- 取消信号关闭 ASR，传给 DeepSeek 和 TTS；轮次 ID 还会过滤已经在路上的迟到消息。
- 既有 Docker 执行器不接收 AbortSignal，已经开始的 SQL 依靠自身时间限制和 finally 清理，返回值在本例被再次检查并丢弃。不能声称点击即杀掉容器或立即停止云端计费。
- 回答一旦播出就不能撤回；金融决策等严格场景应先完整审核文本。此例无自动插话、回声消除算法、多用户鉴权和会话持久化。
- 服务只绑定本机，限制 WebSocket Origin。远程部署需要 HTTPS、鉴权与配额。

## 代码入口

`web/src/App.vue` 的 `record()` / `ask()` / `interrupt()` 分别对应录音、确认分析和停止。
`server/voice.gateway.ts` 接收事件，`server/voice.service.ts` 串起查询、文字流与合成队列。
`server/asr.ts` 接实时识别，`server/model.ts` 接 DeepSeek。
`server/turn.ts` 管轮次和取消，`server/sentences.ts` 整理句子。
`web/src/playback.ts` 管播放顺序，`web/public/pcm-worklet.js` 采集 PCM。

```bash
npm test
npm run build
```

Docker 与课程数据已准备好时，还可以执行 `npm run test:integration`。它会真实运行只读查询，模型与音频使用测试替身，不产生 API 费用。

测试覆盖句子跨块、取消、迟到结果、播放队列、失败降级以及供应商协议。测试中的音频和模型数据为构造样本，不能用测试耗时宣传真实云端延迟。

## 官方资料

- [NestJS WsAdapter](https://docs.nestjs.com/websockets/adapter)
- [千问实时语音识别](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)
- [实时识别客户端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events)
- [实时识别服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [百炼 TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)

协议核对日期：2026-10-09。
