# 07 语音交互 · Python 版

录音 → 百炼 ASR → 核对/修改文字 → 原有 SQL 分析 → 百炼 TTS → 浏览器播放。也可以跳过录音，直接输入文字。

## 文件职责

- `server.py`：FastAPI 本机服务，提供转写、分析和合成三个接口；管理请求锁与回答缓存。
- `speech.py`：标准库 HTTP 请求、音频校验、百炼 ASR/TTS 和音频地址校验。
- `analysis.py`：复用相邻 **Python** 04 的文字分析流程和 05 的受限 Docker 执行。
- `public/`：保留原有录音、核对、表格展示和播放器页面；浏览器端仍使用 JavaScript，运行服务不需要 Node/npm。
- `public/vendor/`：本页面使用的五个 Lucide 图标及许可证，独立本地保存，不使用 CDN。
- `test/`：离线 Mock、临时 HTTP 服务测试，以及单独的真实 Docker 检查。

## 先做离线验证

使用 Python 3.11+ 和 `uv`，在本目录执行：

```bash
uv sync --locked
PYTHONDONTWRITEBYTECODE=1 uv run --locked python -m unittest discover -s test -p 'test_*.py' -v
```

不需要 Key，不调用云端，也不需要 Docker。测试覆盖请求字段、转写与分析分离、金额结果、错误处理、并发锁、缓存和过期；HTTP 测试只启停自己创建的临时端口。样本导入在临时目录完成，不覆盖你已有的数据。

## 运行真实页面

保留本章 Python 03、04、05 的相邻目录。先启动 Docker Desktop，再准备数据和 **Python 版**受限执行镜像：

```bash
cd ../04-text-to-sql
uv run --locked python text_to_sql.py prepare

cd ../05-restricted-execution
uv run --locked python build_image.py

cd ../07-voice-interaction
uv sync --locked
```

服务从进程环境读取 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`DEEPSEEK_API_KEY` 和可选的 `DEEPSEEK_MODEL`（默认 `deepseek-flash`）。百炼沿用 02 图片理解使用的同一地域、业务空间配置，接口地址以 `/compatible-mode/v1` 结尾；需具有 `qwen3-asr-flash`、`qwen3-tts-flash` 的调用权限。

Python **不会自动加载 `.env`**。如果你已经有符合 shell 语法的 `.env`，在本目录加载后启动；如果已在终端导出变量，只执行最后一行即可：

```bash
set -a
source .env
set +a
uv run --locked python server.py
```

访问 [http://localhost:5185](http://localhost:5185)。端口占用时使用 `PORT=5186 uv run --locked python server.py`。服务仅绑定 `127.0.0.1`；请求锁和缓存属于单个进程，不使用多 worker 或自动 reload。

真实转写、分析和合成均会调用云端，可能产生费用；密钥只在服务端使用。本节不创建、复制或修改任何环境文件。

## 演示操作

1. 在新版 Chrome/Edge 中允许麦克风，点击“开始录音”，说：“仅按已导入记录，2026 年 9 月各区域的未扣退款销售额分别是多少？”
2. 点击“结束录音”。转写只填入输入框，**不会自动分析**；核对日期、区域和口径，可以先修改文字。
3. 点击“确认并分析”，查看回答、数据库结果和“查询依据”。原始样本应为华东 **1599.00**、华南 **798.00** 元；模型措辞/列名可能不同，修改过样本时以实际数据为准。
4. 点击“朗读回答”。重复播放复用音频地址，不重复合成；播放被浏览器拦截时点击原生播放器。合成失败不清除已有文字和结果。

录音最多 30 秒、2 MB，仅支持 WebM/Ogg。不支持录音或拒绝授权时，仍可直接输入文字或点击“填入示例”。问题/转写上限沿用原例的 2000 个 UTF-16 单元；朗读按 Unicode 码点计数，短回答直接播放，超过 500 字符改为“查看全文”的提示，不截断金额或限制条件，不额外调用摘要模型。

这是一次问题、一次回答的入口，没有跨轮记忆。追问时请填写完整问题再提交；完整图表报告见 06。本节不新增远程部署、身份认证或配额系统。

## 数据、缓存与失败处理

本地不保存录音、转写文件或合成音频。内存最多保留最近 10 条回答，每条 15 分钟后失效，新增回答时清除过期项，重启也会清除。TTS 只接受本服务生成的 `answerId`，不接收任意朗读文本；音频 URL 只允许预期 OSS 域名并升级为 HTTPS，供应商链接也可能过期。

转写向百炼发送录音；分析向 DeepSeek 发送问题、Schema、口径与必要查询结果；合成向百炼发送朗读文本。本地不落盘不代表云端不处理或保存数据，真实业务数据须先核对供应商政策。

语音请求使用标准库，单次网络操作超时为 60 秒；浏览器转写/合成等待上限为 70 秒，分析为 180 秒。失败直接显示错误，不自动重复发送录音或合成请求。401/403 核对权限与地域，429 等待后手动重试；`Workspace endpoint is invalid` 核对业务空间 ID、Key 和地域。

## 可选真实 Docker 验证

准备好 Python 05 镜像后，在本目录执行：

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --locked python test/sandbox_check.py
```

只固定模型决策，样本导入、数据加载、Docker SQL 和清理走真实实现；预期输出华东 1599.00、华南 798.00。没有镜像或 Docker 未启动会明确失败，不以 Fake 替代容器。此命令及离线测试均不调用 ASR、DeepSeek 或 TTS，不能替代真实麦克风和云端联调。

依赖：FastAPI/Uvicorn 提供 HTTP 服务；DuckDB/openpyxl 用于相邻 Python 小节的数据流程；HTTPX2 仅用于离线测试，与当前 Starlette TestClient 配套。依赖版本由 `uv.lock` 固定。

官方接口：[Qwen-ASR](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)、[Qwen-TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[百炼地域与业务空间](https://help.aliyun.com/zh/model-studio/regions)。
