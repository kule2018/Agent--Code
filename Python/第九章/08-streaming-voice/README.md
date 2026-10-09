# 08 流式语音与打断 · Python 版

FastAPI + Vue 3 的流式语音实验：实时识别 → 核对文字 → 受限 SQL 查询 → 流式回答 → 逐句合成与播放。可以随时停止本轮，也可以对比“逐句返回”和“完整后返回”。保留原例的交互、中文注释与数据口径，不提供真实页面的 Replay 开关。

## 文件职责

- `server/main.py`：本机 FastAPI 服务、健康检查和 WebSocket 来源校验。
- `server/voice_gateway.py`：接收录音、提问、结束和取消事件；每个连接独立管理任务。
- `server/voice_service.py`：串起真实查询、文字流和单并发合成队列，是本节主流程。
- `server/asr.py`、`model.py`、`tts.py`：实时 ASR WebSocket、DeepSeek SSE 与百炼 TTS；取消时关闭上游连接，不自动重试。
- `server/turn.py`、`sentences.py`：轮次过滤、取消信号和跨块句子整理。
- `web/`：独立的 Vue 页面与前端依赖；`playback.ts` 管播放顺序，`recorder.ts` / `pcm-worklet.js` 采集 PCM。
- `shared/protocol.ts`：前端事件类型。`test/`：离线测试、本机通信测试及可选 Docker 检查。

后端只复用本章相邻 **Python** 03、04、05、07 的数据和执行逻辑，不读取其他语言目录。浏览器仍需 Vue/TypeScript；npm 只用于本节前端，后端不依赖 NestJS 或 Node 服务。

## 先做离线验证

Python 3.11+、uv；前端使用 Node.js 22.20+。在本节目录执行：

```bash
uv sync --locked
PYTHONDONTWRITEBYTECODE=1 uv run --locked python -m unittest discover -s test -p 'test_*.py' -v

cd web
npm ci
npm test
npm run build
cd ..
```

测试不需要 Key，不调用云端，也不需要 Docker。覆盖供应商请求字段、真实本机 WebSocket、SSE 跨块、句子边界、打断与迟到结果、TTS 失败降级、播放队列和 PCM。样本导入只在临时目录进行，不覆盖现有数据；测试耗时不能代表真实云端延迟。

## 运行真实页面

保留 Python 03、04、05、07 的相邻目录。先启动 Docker Desktop，准备数据及 **Python 版**受限执行镜像；已经完成这些步骤则不必重复：

```bash
cd ../04-text-to-sql
uv run --locked python text_to_sql.py prepare
cd ../05-restricted-execution
uv run --locked python build_image.py
cd ../08-streaming-voice
uv sync --locked
```

服务从进程环境读取 `DEEPSEEK_API_KEY`、可选 `DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`。百炼 Key、业务空间和地域必须匹配，地址使用控制台给出的真实兼容接口地址；需要 `qwen3-asr-flash-realtime` 与 `qwen3-tts-flash` 权限。

Python 不会自动加载 `.env`。若你已有符合 shell 语法的 `.env`，在本节的**后端终端**中加载后启动；已导出变量则只执行最后一行：

```bash
set -a
source .env
set +a
uv run --locked python -m server.main
```

另开终端，在本节 `web` 目录启动页面：

```bash
npm ci
npm run dev
```

访问 [http://localhost:5186](http://localhost:5186)，后端为 `127.0.0.1:4316`。端口占用时，分别在**两个终端**导出相同的 `PORT` 和 `WEB_PORT` 后再启动，例如 `export PORT=4317 WEB_PORT=5187`。前端代理、后端来源白名单必须一致。本节 Vite 已禁用自动读取环境文件；密钥只由后端使用，修改进程配置后须重启对应服务。

真实识别、分析和合成可能产生费用。本节不创建、复制或修改任何环境文件。

## 演示操作与预期结果

1. 使用新版 Chrome/Edge，允许麦克风，点击“开始录音”。说：“仅按已导入记录，2026 年 9 月各区域的未扣退款销售额分别是多少？”观察识别预览，再结束录音。
2. 核对/修改最终文字，点击“确认并分析”；识别结束不会自动执行 SQL。
3. 查看表格、查询依据、流式文字和逐句朗读。原始样本应为华东 **1599.00**、华南 **798.00** 元；修改过样本时以真实结果为准。
4. 播放被浏览器拦截时点击“继续播放”。合成某段失败只提示该段，保留文字与表格，并继续合成后续段。
5. 回答中点击“停止本轮”，或者提交完整的新问题；旧轮次的迟到文字、查询和音频不能进入新轮次。切换两种返回方式，观察页面四项时间指标。

每次问题都是独立任务，“只看华东”快捷项填写的是完整问题，不代表跨轮记忆。

## 范围与限制

ASR 使用 16kHz、PCM16、单声道，浏览器每 100ms 发送一个音频块，录音最多 30 秒。服务端 VAD 按句识别，应用按 `item_id` 累积；预览不能冒充最终结果。识别等待上限 45 秒，分析轮次上限 120 秒。

文字是 SSE 增量，语音是**完整句子合成的音频 URL**，不是 PCM 音频帧推送。逐句模式遇到完整句子即排入 TTS；完整后返回模式等待全文，再合成一次。沿用原例的 600 个 UTF-16 单元回答上限、500 个单句单元上限和最多 24 段；合成按原顺序单并发，播放也是顺序队列。

打断会取消 ASR、模型和 TTS，并清空浏览器播放队列。已开始的 Docker SQL 不强行中断，仍等待执行器自身超时与清理，再丢弃旧结果；不能承诺立即停止容器或云端计费。已经播出的回答也不能撤回。服务仅绑定本机，限制 Origin、消息大小和待发送缓冲；没有自动插话、多用户鉴权或会话持久化。

## 可选真实 Docker 检查

构建好 Python 05 镜像后，在本节目录执行：

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --locked python test/sandbox_check.py
```

该检查使用临时真实样本和 Python 05 容器，只替换模型和音频；预期查询金额同上。Docker 或镜像缺失会明确失败，不回退到宿主执行，也不借用其他语言的镜像。离线测试、页面构建和此检查都不能替代真实麦克风与云端联调。

依赖由 `uv.lock` 与 `web/package-lock.json` 固定。FastAPI/Uvicorn 提供本机服务；websockets 处理实时识别；HTTPX2 提供可取消的异步 HTTP/SSE；DuckDB/openpyxl 用于相邻小节的数据流程。

官方资料：[实时 ASR 客户端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)、[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[百炼 TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)。
