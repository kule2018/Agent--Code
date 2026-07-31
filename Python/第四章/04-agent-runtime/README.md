# 04-agent-runtime

本节用 Python 复刻 Node 版的 Agent Runtime。它不负责生成 Action，也不负责判断业务结论是否正确，而是专门负责维护 Agent Run State、执行预算、重复 Action 检测、无进展检测、Plan 完成检查和停止原因。

## 文件职责

- `incident_data.py`：本地故障数据，沿用 payment-service 的监控、日志和发布记录。
- `incident_tools.py`：执行 Runtime 已允许的工具调用，并返回带 `evidenceKey` 的 Observation。
- `runtime_state.py`：维护 Agent Run State、预算、轨迹、证据进展和终止规则。
- `scripted_decision_provider.py`：用确定性决策序列替代真实模型，提供 4 个实验场景。
- `agent_runtime.py`：驱动完整 Agent Run 循环。
- `demo.py`：命令行入口，可以运行全部实验或指定实验。
- `tests/`：离线测试，不调用真实 API。

## 离线验证

```bash
python3 -B -m unittest discover -s tests -v
```

关键预期结果：测试会验证正常完成、重复 Action、连续无进展、工具预算耗尽、Token 预算耗尽和过早最终回答失败。

## 运行演示

运行全部实验：

```bash
python3 demo.py
```

只运行某个实验：

```bash
python3 demo.py complete
python3 demo.py repeat
python3 demo.py no-progress
python3 demo.py budget
```

## 依赖说明

Python 版只使用标准库，不需要额外安装第三方依赖。本节不调用 DeepSeek API，也不需要环境变量。
