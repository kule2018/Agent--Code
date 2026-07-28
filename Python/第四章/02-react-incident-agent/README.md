# 02-react-incident-agent

本节用 Python 复刻 Node 版的最小 ReAct 故障排查 Agent。Agent 会根据模型提出的 Action 调用本地只读工具，把工具返回的 Observation 放回消息历史，直到模型生成最终排查结论。

## 文件职责

- `incident_data.py`：本地故障数据模拟器，提供两个场景：版本发布回归、数据库连接池耗尽。
- `incident_tools.py`：定义模型可调用的 5 个只读工具，并负责工具参数校验和 Observation 组装。
- `deepseek_client.py`：调用 DeepSeek Chat Completions，字段和 Node 版保持一致。
- `react_agent.py`：最小 ReAct 执行循环，负责维护消息历史、执行工具和记录轨迹。
- `demo.py`：命令行入口，用于选择故障场景并启动 Agent。
- `tests/`：离线测试，不调用真实 DeepSeek API。

## 离线验证

```bash
python3 -B -m unittest discover -s tests -v
```

关键预期结果：测试会验证工具校验、两条故障路线、DeepSeek 请求体和缺少密钥时的错误提示。

## 真实 API 运行

Python 标准解释器不会自动读取 `.env`。如果你已经在当前目录准备好了自己的 `.env`，先加载它，再运行：

```bash
set -a
source .env
set +a
python3 demo.py release-regression
```

也可以切换到数据库连接池场景：

```bash
set -a
source .env
set +a
python3 demo.py database-pool
```

本节从源码中推断使用这些环境变量：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`。

## 依赖说明

Python 版只使用标准库，不需要额外安装第三方依赖。
