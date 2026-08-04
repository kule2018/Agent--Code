# 05-result-validation-recovery

本节用 Python 复刻 Node 版的结果校验与失败恢复案例。核心不是让模型继续生成内容，而是在工具返回之后，由 Runtime 判断结果是否可用，并根据失败类型选择 retry、fallback、replan 或 human handoff。

## 文件职责

- `incident_data.py`：本地故障数据，包含日志、调用链和实例清单证据。
- `incident_tools.py`：按实验场景创建工具执行器，稳定复现超时、空结果和证据冲突。
- `result_validator.py`：校验单条 Observation 和多份证据组合是否可信。
- `recovery_policy.py`：根据 failure、action 和 retry 次数选择恢复策略。
- `recovery_state.py`：创建本节的 Agent Run State 和初始 Plan State。
- `recovery_runtime.py`：执行步骤、校验结果、应用恢复策略并更新运行状态。
- `demo.py`：运行三个实验场景。
- `test.py`：和 Node `test.js` 对齐的轻量验证入口。
- `tests/`：更细的离线单元测试。

## 离线验证

```bash
python3 -B -m unittest discover -s tests -v
python3 test.py
```

关键预期结果：

- `retry-fallback`：先 retry，再 fallback 到 `query_backup_logs`，最终完成。
- `replan`：空日志结果被拒绝，取消原步骤并追加 `query_traces` 替代步骤。
- `handoff`：日志版本和实例清单版本冲突，进入人工接管。

## 运行演示

运行全部实验：

```bash
python3 demo.py
```

只运行某个实验：

```bash
python3 demo.py replan
python3 demo.py handoff
python3 demo.py retry-fallback
```

## 依赖说明

Python 版只使用标准库，不需要额外安装第三方依赖。本节不调用 DeepSeek API，也不需要环境变量。
