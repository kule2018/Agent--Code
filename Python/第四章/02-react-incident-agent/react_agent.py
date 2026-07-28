"""最小 ReAct Agent 执行循环。"""

import inspect
import json
import pprint

from deepseek_client import MODEL, call_deepseek

# 当前最小案例最多执行 8 次模型调用。
#
# 这里只把它当作防止无限循环的最后保护。
# 完整的执行预算和终止条件会在后续小节实现。
MAX_STEPS = 8

SYSTEM_PROMPT = """你是一个线上故障排查 Agent。

你的任务是根据工具返回的真实数据，找出最可能的故障原因并给出处理建议。

执行规则：
1. 不能猜测监控、日志、数据库或发布信息，所有事实必须来自工具结果。
2. 每一轮只调用一个工具，读取 Observation 后再决定下一步。
3. 在生成最终结论前，至少检查服务状态、监控指标和错误日志。
4. 完成上面三项检查以后，只能根据 Observation 选择一条验证路线：
   - 日志显示错误与服务版本或代码变更有关：查询最近发布记录。
   - 指标或日志显示数据库连接池异常：检查数据库连接池。
5. 完成对应路线的验证以后直接生成最终回答，不要为了排除所有可能性再调用另一条路线。
6. 不要重复相同调用。
7. 最终回答必须包含：最可能原因、关键证据、建议动作和暂时无法确认的信息。

当前工具都是只读工具。你只能提出处理建议，不能声称已经重启服务或者回滚版本。"""


async def run_react_agent(*, goal, tools, execute_tool_call=None, executeToolCall=None, call_model=None):
    """运行最小 ReAct Agent。

    每一步只观察应用程序能够拿到的数据：

    Action：模型提出的 tool_call
    Observation：工具执行后返回的真实结果
    """

    execute_tool_call = execute_tool_call or executeToolCall
    call_model = call_model or call_deepseek

    if execute_tool_call is None:
        raise ValueError("缺少 execute_tool_call。")

    messages = [
        {
            "role": "system",
            "content": SYSTEM_PROMPT,
        },
        {
            "role": "user",
            "content": goal,
        },
    ]

    # trajectory 只记录可以被应用程序观察的执行过程。
    trajectory = []

    print(f"模型：{MODEL}")
    print(f"目标：{goal}")

    for step in range(1, MAX_STEPS + 1):
        print(f"\n================ Step {step} ================")

        result = call_model(messages=messages, tools=tools)
        if inspect.isawaitable(result):
            result = await result

        tool_calls = result.get("message", {}).get("tool_calls") or []

        print(f"模型调用：{result.get('latencyMs')}ms，finish_reason={result.get('finishReason')}")

        # 没有 tool_calls，表示模型认为已经可以生成最终回答。
        if len(tool_calls) == 0:
            final_answer = result["message"].get("content")

            print("\nFinal Answer：")
            print(final_answer)

            print_trajectory(trajectory)

            return {
                "finalAnswer": final_answer,
                "trajectory": trajectory,
            }

        # 完整保留模型返回的 assistant 消息。
        #
        # 下一条 role=tool 消息需要通过 tool_call_id
        # 与这里的 tool_calls 建立对应关系。
        messages.append(
            {
                "role": "assistant",
                "content": result["message"].get("content"),
                "tool_calls": tool_calls,
            }
        )

        for tool_call in tool_calls:
            action = {
                "toolName": tool_call["function"]["name"],
                "arguments": parse_arguments_for_display(tool_call["function"].get("arguments")),
            }

            print("\nAction：")
            pprint.pp(action)

            observation = execute_tool_call(tool_call)
            if inspect.isawaitable(observation):
                observation = await observation

            print("\nObservation：")
            pprint.pp(observation)

            trajectory.append(
                {
                    "step": step,
                    "action": action,
                    "observation": observation,
                }
            )

            # 将真实 Observation 放回 messages。
            #
            # 下一轮模型调用时，模型会看到这份结果，
            # 再决定下一个 Action。
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call["id"],
                    "content": json.dumps(observation, ensure_ascii=False),
                }
            )

    raise RuntimeError(f"达到最大执行步数 {MAX_STEPS}，Agent 仍然没有生成最终回答。")


def parse_arguments_for_display(raw_arguments):
    """解析工具参数仅用于终端展示。

    真正执行时仍会在 incident_tools.py 中重新解析和校验，
    不能因为这里解析成功就跳过工具参数校验。
    """

    try:
        return json.loads(raw_arguments or "{}")
    except json.JSONDecodeError:
        return raw_arguments


def print_trajectory(trajectory):
    """打印本次任务经过的 Action 路径。"""

    print("\n执行路径：")

    for item in trajectory:
        print(f"{item['step']}. {item['action']['toolName']}")
