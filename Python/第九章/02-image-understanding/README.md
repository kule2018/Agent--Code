# 图片理解：截图里的信息怎样进入 Agent（Python）

独立的 Python 图片输入实验：读取销售看板，构建视觉请求，校验 JSON 字段，整理待确认项并保存结果。这里只执行一次视觉请求，没有多轮 Agent Loop，也不执行 Excel 统计。

使用 Python 3.11 或更新版本，只有标准库依赖。以下命令在本小节目录执行；可将 `uv run python` 换成 `python3`。

## 先做离线验证

```bash
uv run python image_understanding.py request
uv run python -m unittest -v
```

`request` 显示文本和图片位于同一条消息的请求结构，省略完整 Base64；不需要密钥，不调用模型，也不生成 `outputs/`。测试使用构造响应和本地模拟 HTTP，只验证程序逻辑，不验证图片识别能力。

## 调用真实视觉模型

当前进程需要 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`；可选 `VISION_MODEL`，默认 `qwen3-vl-flash`。Key、模型权限和 Base URL 需属于对应地域与业务空间。Base URL 使用控制台给出的 HTTPS 业务空间地址，路径以 `/compatible-mode/v1` 结尾，不追加 `/chat/completions`。[地域与接入地址说明](https://help.aliyun.com/zh/model-studio/regions/)

程序不自动读取环境文件。如果你已有 `.env`，并且其内容符合 Shell 赋值语法，可先加载：

```bash
set -a
source .env
set +a
uv run python image_understanding.py clear
uv run python image_understanding.py incomplete
```

若已有文件不是 Shell 语法，请通过终端或 IDE 将上述变量传入进程，不能直接 `source`。本节不附带、不生成或修改任何环境文件。

自定义图片：

```bash
uv run python image_understanding.py clear "/你的目录/销售看板.png"
```

默认执行 `clear`。支持 PNG、JPEG、WebP，通过文件头识别格式；本例将原文件大小限制为非空且不超过 5 MiB。固定问题针对销售额，图片需与该问题相符。真实调用会发送图片并产生费用，请只使用有权发送的图片；请求超时为 60 秒，不自动重试。

## 文件与结果

- `image_understanding.py`：图片编码 → 请求组装 → HTTP 调用 → 严格字段校验 → 待确认判断 → 保存结果。保留了中文教学注释。
- `samples/dashboard-clear.png`、`samples/dashboard-incomplete.png`：独立的清晰与遮挡样本。
- `samples/dashboard.html`：两张截图的源页面；1280 × 790 视口打开，追加 `?mode=incomplete` 查看遮挡版。模型只收到 PNG，不读取 HTML。
- `test_image_understanding.py`：请求、字段校验、错误边界、结果文件及本地模拟接口测试。
- `pyproject.toml`、`uv.lock`：Python 版本要求与可复现运行配置，不需要安装第三方包。
- `outputs/<模式>-<毫秒时间戳>.json`：成功调用后生成，记录图片文件名、SHA-256、模型、问题、读取结果、确认项和 API 用量。

清晰样本可见事实为：2026-09-01 至 2026-09-30，销售额 128.60 万元，全部区域、已支付订单实付金额、未扣除退款。这些是教学图片的内容，不是预置的模型输出。遮挡样本无法确认时间、销售额数值和单位，应返回对应字段为 `null` 并进入 `needs_confirmation`，请与原图核对模型实际表现。

`extracted` 仅表示必需字段有值、模型未提示不确定性且存在文字摘录，不表示事实已经核验。JSON 合法也不能防止模型猜测；涉及业务金额时仍需核对原图与原始数据。图片中的文字始终是待分析资料，不是程序应执行的指令。

遇到 `401/403` 检查地域、Key 和权限；`404` 检查地址与模型名；`429` 检查额度与限流。JSON 模式要求模型支持该输出方式，本例保持 `enable_thinking: false`。[JSON 输出支持范围](https://help.aliyun.com/zh/model-studio/qwen-structured-output)、[视觉输入与 Base64](https://help.aliyun.com/zh/model-studio/vision)
