# AI 数据分析 Agent

独立的第九章实战项目：NestJS + Vue 3 + LangGraph + DuckDB + ECharts。上传销售 Excel / CSV，确认工作表和字段后，通过文字或语音分析区域趋势、连续下降和商品降幅；每份结果都保留 SQL、数据版本和真实结果表，可导出离线 HTML 报告与 CSV。

## 启动

需要 Node.js >= 22.20、Docker Desktop。终端进入本项目目录：

```bash
npm install
npm run build:sandbox
npm run dev
```

页面：`http://localhost:5187`，服务：`http://127.0.0.1:4317`。先打开 Docker Desktop。镜像第一次构建需要访问 Docker Hub 和 npm，超时时先检查 Docker 的网络和镜像配置。

`samples/` 已提供可下载的 XLSX、CSV、质量问题文件和看板截图；`npm run samples` 可以重建数据文件。无需启动其他小节、安装 PostgreSQL 或手工准备 DuckDB 服务。

Replay 演示不需要 Key。它识别页面示例问题，使用真实上传数据和真实 Docker 查询；支持固定 `dashboard.png` 的图片演示。自由问题和其他截图需要切换 AI 分析。语音识别和朗读在两种模式中均使用真实百炼服务，需要相应 Key。

## AI 与语音配置

自行在项目根目录创建 `.env`，填写：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com

DASHSCOPE_API_KEY=你的百炼 API Key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3-vl-flash
```

百炼 Key 与完整接口地址必须属于同一地域、同一业务空间。使用独立业务空间时，应填控制台给出的完整地址，不能把空间名称直接放进 URL。北京、新加坡兼容接口地址均可配置。

服务从 `.env` 加载配置；修改配置或服务端代码后，用 Ctrl+C 停止 `npm run dev`，再启动。项目不生成或修改任何 `.env` 文件。

端口已被其他项目占用时，可使用：

```bash
PORT=4318 WEB_PORT=5188 npm run dev
```

服务端、页面代理与语音 Origin 校验都会使用这两个变量。先查看已有服务，不要反复启动同一个项目。

## 操作与标准结果

1. 上传 `samples/sales-demo.xlsx`，选“销售明细”，确认五个字段，导入 18 行。首行是表头，金额单位为元；CSV 必须是 UTF-8。
2. 问“哪些区域连续两个月净销售额下降？”：华东 7 / 8 / 9 月为 30000 / 25000 / 20000 元。
3. 在同一会话追问“只看华东，哪些商品贡献了主要降幅？”：比较 8 月和 9 月，咖啡机降 4000 元，占净降幅 80%；键盘降 1000 元，占 20%。
4. 问“9月全部区域净销售额是多少？”：59000 元。实付金额是 60000 元，退款 1000 元，两种口径不要混用。
5. 上传 `samples/dashboard.png`，检查它明确标注“未扣退款”，确认核对：原表同口径为 60000 元，与截图一致。
6. 右侧查看图表、结果表、依据、查询原始结果，导出报告。左侧“分析记录”可恢复原会话；新数据版本会创建不同数据集，原会话仍固定旧版本。
7. 配置百炼后录音，结束后核对转写文本，再确认分析。右侧“朗读结果”逐句合成并播放，“停止播放”会清空队列、取消后续合成。浏览器限制自动播放时点击“继续播放”。
8. 上传 `sales-issues.xlsx`：页面显示非法日期、空值 / 非数值、退款超过实付和重复行，查询被阻止。系统不自动删除问题数据，修正文件后重新上传。

## 结构

```text
server/
  app.controller.ts       上传、分析、截图、报告与朗读入口
  dataset.service.ts      数据预览、导入、版本与 DuckDB 建库
  table-parser.ts         工作表、字段映射与质量校验
  workflow.ts             决策 → 查询 → 错误修正 / 报告
  model.ts                AI 决策与 SQL，Replay 调用入口
  analysis.ts             标准 SQL、真实结果的计算和图表配置
  sandbox.ts              临时只读容器、超时与取消
  analysis.service.ts     会话、条件继承与已完成报告保存
  report.ts               离线 SVG 图表、HTML 与 CSV
  multimodal.service.ts   图片识别、口径复核与逐句 TTS
  voice/                  实时 ASR 网关
runtime/                  固定的受限查询镜像
web/                      Vue 分析工作台
samples/                  可复算业务数据与截图
data/                     原件、不可变数据版本、会话、导出报告
```

AI 返回结构化分析计划和 SQL，LangGraph 调用受限查询工具。对 AI SQL 的结果，应用会通过标准查询独立核对；数字、贡献百分比和图表都由程序从实际结果生成。两次查询尝试仍无法得到有效结果时，页面保留原因，不生成成功报告。

每个数据版本拥有独立 `data.duckdb`；模型 SQL 只能使用已开放的 SELECT、聚合和字段表达式。运行时关闭网络、外部文件访问、扩展加载与写入，每次只挂载当前数据库的只读副本，并设置 CPU、内存、时间和输出限制。

## 验证

```bash
npm test
npm run build
npm run verify
```

`verify` 需要 Docker 和已构建镜像。它使用临时数据目录测试实际 Excel 导入、重复内容识别、下降趋势、商品贡献、历史恢复、截图口径、报告导出和 SQL 越界拒绝，不调用收费 API。测试结束后删除其临时数据。

## 当前边界

这是单用户本地销售分析项目。数据必须能够映射为日期、区域、商品、实付金额与退款金额；首行为单行文字表头，不支持合并单元格或直接采用公式缓存。空退款与缺失月份都不会自动当成零。

支持金额汇总、月度趋势、连续下降和商品净降幅贡献。Agent 可以决定分析维度、沿用追问条件并修正查询，报告交付采用确定性计算。预测、因果归因与任意生成代码执行未开放。

数据与已完成报告保存在本地 JSON 和 DuckDB 文件中，页面刷新和重启后可以继续会话；没有使用 Checkpointer 保存正在运行的计算，不自动恢复中途被服务重启打断的查询。多用户部署时需要另外加入鉴权、租户隔离及并发存储。

停止分析会取消模型请求、删除正在运行的容器；停止朗读会清空浏览器队列并取消后续请求。已播放声音无法撤回，客户端取消也不保证供应商已经停止计费。语音是实时转写加逐句 TTS，没有自动插话打断。

真实云端调用与 Replay 分开。单元测试中的供应商响应使用测试替身，不能据此声称线上模型已验证。

## 官方资料

核验日期：2026-10-09。

- [NestJS 文件上传](https://docs.nestjs.com/techniques/file-upload)
- [LangGraph Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)
- [DuckDB Node Neo](https://duckdb.org/docs/stable/clients/node_neo/overview)
- [ExcelJS](https://github.com/exceljs/exceljs)
- [ECharts](https://echarts.apache.org/handbook/en/get-started/)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [百炼视觉理解](https://help.aliyun.com/zh/model-studio/vision)
- [百炼实时语音识别](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)
- [百炼语音合成](https://help.aliyun.com/zh/model-studio/qwen-tts-api)
