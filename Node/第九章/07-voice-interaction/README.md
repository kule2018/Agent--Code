# 07 语音交互

最小链路：录音 → ASR → 核对文字 → 原有 SQL 分析 → TTS → 浏览器播放。

## 运行

使用 Node.js 22 或以上版本。在本目录执行 `npm install`。

保留 03、04、05 的相邻目录，并先完成：

- 03、04、05 各自的依赖安装；
- 04 目录执行 `npm run prepare-data`；
- 05 目录执行 `npm run build:sandbox`，保持 Docker Desktop 运行。

在本目录自行配置 `.env`，项目不会替你创建或修改环境文件：

```dotenv
DASHSCOPE_API_KEY=百炼APIKey
DASHSCOPE_BASE_URL=https://你的业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
DEEPSEEK_API_KEY=DeepSeekAPIKey
DEEPSEEK_MODEL=deepseek-flash
```

百炼沿用 02 图片理解验证过的同一地域、业务空间配置，并确认开通 `qwen3-asr-flash`、`qwen3-tts-flash`。

执行 `npm run dev`，访问 http://localhost:5185 。端口占用时使用 `PORT=5186 npm run dev`。

录音使用最新版 Chrome / Edge，允许麦克风访问。单次最多 30 秒、2 MB，浏览器输出 WebM 或 Ogg；不支持对应格式时仍可输入文字。远程部署需要 HTTPS 和额外的身份、配额控制；当前只绑定本机。

## 操作

1. 点击“开始录音”，说：“仅按已导入记录，2026 年 9 月各区域的未扣退款销售额分别是多少？”
2. 点击“结束录音”。ASR 文字只填入输入框，不自动提交查询。
3. 核对日期、区域和口径，点击“确认并分析”。也可以直接输入相同文字。
4. 对照实际 SQL 和结果：课程原始样本为华东 1599.00、华南 798.00 元。模型措辞和列名可能不同；修改过样本时，以实际数据为准。
5. 点击“朗读回答”。合成失败只显示错误，已有分析结果继续保留。播放被浏览器拦截时，使用原生播放器的播放按钮。

这是一次问题、一次回答的语音入口。需要追问时，在输入框中补全完整问题再提交，不实现跨轮对话记忆。页面展示结论、表格和查询依据；完整图表报告见 06。

## 文件职责

- `public/app.js`：三个按钮入口、麦克风管理、展示与播放。
- `server.js`：本地 Web 服务，转写、分析和合成三个接口。
- `speech.js`：百炼 ASR / TTS 的实际 HTTP 调用。
- `analysis.js`：复用 04 的 `answerQuestion()` 与 05 的 `runSandbox()`。

短回答直接朗读；超过 500 字符则保留全文并播放查看提示，避免截断金额与限制条件。本例不额外调用一个摘要模型，也不朗读 SQL 或整张表。

## 数据与费用

密钥仅在服务端使用。转写向百炼发送录音；分析向 DeepSeek 发送问题、Schema、统计口径与必要查询结果；合成向百炼发送朗读文本，均可能计费。

本地服务不把录音写入磁盘、不持久化转写文本；最多在内存中保留最近 10 条回答用于朗读，15 分钟后失效，访问时清除过期记录，服务重启也会清除。供应商返回的合成音频地址有有效期，页面仅用于临时播放；本地不落盘不代表云服务不处理或保存数据，使用真实业务数据前须核对供应商的数据政策。

## 验证

```bash
npm test
npm run test:integration
```

`npm test` 使用测试替身核对 API 请求格式、错误处理与三个接口的衔接，不需要 Key。

`test:integration` 使用真实课程数据库与 Docker，只固定模型决策以核对查询结果，不调用付费接口。这两项测试不能替代真实麦克风和云端 ASR / TTS 的联调。

## 官方接口

- [Qwen-ASR](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [Qwen-TTS](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
- [百炼地域和业务空间域名](https://help.aliyun.com/zh/model-studio/regions)

`Workspace endpoint is invalid` 先核对业务空间 ID、Key 和地域；401 / 403 核对模型权限，429 等待后手动重试。不自动重复发送录音或合成，以免重复计费。
