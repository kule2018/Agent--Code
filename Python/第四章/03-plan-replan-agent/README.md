# 03-plan-replan-agent

本节用 Python 复刻 Node 版的 Plan-and-Replan 故障排查 Agent。它先让 Planner 生成显式计划，再由应用程序维护 Plan State；每执行一个工具步骤后，Replanner 会根据 Observation 决定继续、取消 pending 步骤、追加新步骤或结束任务。

## 文件职责

- `incident_data.py`：本地故障数据，包含初始告警、监控、连接池、日志和发布记录。
- `incident_tools.py`：提供 4 个只读工具，并校验计划步骤中的工具参数。
- `deepseek_client.py`：调用 DeepSeek Chat Completions，Planner / Replanner 使用 JSON Output。
- `plan_schema.py`：解析和校验模型返回的初始计划、重新规划决定。
- `plan_state.py`：维护步骤状态、依赖、取消、新增步骤和修订记录。
- `planner.py`：封装 Planner 与 Replanner 的模型调用 Prompt。
- `plan_agent.py`：执行计划循环，并在满足完成条件后生成最终结论。
- `demo.py`：命令行入口。
- `tests/`：离线测试，不调用真实 DeepSeek API。

## 离线验证

```bash
python3 -B -m unittest discover -s tests -v
```

关键预期结果：测试会验证初始计划校验、重规划状态合并、错误边界、完整 Plan-and-Replan 路线和 DeepSeek 请求体。

## 真实 API 运行

Python 标准解释器不会自动读取 `.env`。如果你已经在当前目录准备好了自己的 `.env`，先加载它，再运行：

```bash
set -a
source .env
set +a
python3 demo.py
```

本节从源码中推断使用这些环境变量：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`。

## 依赖说明

Python 版只使用标准库，不需要额外安装第三方依赖。
