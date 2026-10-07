# 图片理解：截图里的信息怎样进入 Agent

独立的 Node.js 图片输入示例。一次视觉请求读取销售看板，Zod 检查结构，应用整理待确认项并保存结果。这里没有多轮 Agent Loop，也不执行 Excel 统计。

## 运行

使用 Node.js 22 或更新版本，在本目录执行：

```bash
npm install
```

在本目录自行配置 `.env`（仓库不附带或自动生成该文件）：

```dotenv
DASHSCOPE_API_KEY=你的百炼_API_Key
DASHSCOPE_BASE_URL=https://你的业务空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen3-vl-flash
```

在百炼控制台选择华北2（北京），创建相应地域的 API Key，并在业务空间详情查看业务空间 ID。使用该空间对应的 OpenAI 兼容 Base URL，末尾保留 `/compatible-mode/v1`，不要追加 `/chat/completions`。模型需在当前空间可调用。

- [API Key 获取说明](https://help.aliyun.com/zh/model-studio/get-api-key)
- [Base URL 与地域说明](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)

```bash
npm run request
npm run clear
npm run incomplete
```

`request` 无需密钥，只展示省略 Base64 正文的请求。后两条命令会真实发送对应图片到百炼，可能产生费用；不要提交未经授权的业务截图。默认不自动重试请求。

自定义图片：

```bash
npm run clear -- "/你的目录/销售看板.png"
```

支持 PNG、JPEG、WebP。本例自行设置原文件不超过 5 MiB 的限制。图片内容需适合本例固定的销售额问题，不是通用问图命令。

## 文件说明

- `image-understanding.js`：从 `main()` 读取图片、组装请求、解析响应、判断待确认项并保存结果。
- `samples/dashboard-clear.png`：清晰的模拟销售看板。
- `samples/dashboard-incomplete.png`：时间、销售额和单位被遮挡的对照样本。
- `samples/dashboard.html`：两张截图的源页面。浏览器以 1280 × 790 视口打开；追加 `?mode=incomplete` 可查看遮挡版。示例调用只发送 PNG，不读取 HTML。
- `image-understanding.test.js`：不联网的程序逻辑测试，包含本地模拟接口。
- `outputs/`：运行成功后生成的真实模型结果，包含来源文件 Hash、模型名和 API 用量，已忽略 Git 跟踪。

## 核对结果

清晰图片的可见事实：销售经营看板，2026-09-01 至 2026-09-30，销售额 128.60 万元，全部区域、已支付订单实付金额、未扣除退款。这些是教学图片中的内容，不是预先保存的模型输出。

遮挡图片无法确认统计时间、销售额数值和单位。核对模型是否将它们返回为 `null`，并进入 `needs_confirmation`。模型可能仍然误识别或猜测；若发生，记录为识别失败，不能据此认定程序已经保障事实正确。

`extracted` 只表示必需字段有值且模型未提示不确定性。JSON 合法、Schema 通过、文字摘录存在都不能证明事实正确。图片里出现的文字是待分析资料，后续接入 Agent 时仍需要保持数据与指令分离。

## 验证

```bash
npm run check
npm test
```

本地测试不使用 API Key、不调用视觉模型；通过只能说明请求组装、字段校验、缺失信息处理和 SDK 响应解析正常。真实识别效果需要配置密钥以后分别执行两个图片实验。

常见问题：`401/403` 检查地域、Key 与模型权限；`404` 检查 Base URL 和模型名；`429` 检查额度与限流；JSON 模式错误检查所选视觉模型是否支持，并保持 `enable_thinking: false`。

技术文档核对日期：2026-10-04。使用 `qwen3-vl-flash`、非思考模式、JSON Object 输出，具体调用可用性以当前账户与地域为准。

- [视觉输入与 Base64](https://help.aliyun.com/zh/model-studio/vision)
- [JSON 输出支持范围](https://help.aliyun.com/zh/model-studio/qwen-structured-output)
