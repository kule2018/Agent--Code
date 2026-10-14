"""带 Trace 的查询 Agent：记录工具执行和组装 Tool Message 的前后数据。"""

from copy import deepcopy
import json

from scoring import execute_order_tool, parse_json


VARIANTS = ("wrong-unit", "fixed", "repeat")
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_order",
        "description": "根据订单号查询当前登录用户的订单，paidAmountYuan 的单位为元。",
        "parameters": {"type": "object", "properties": {"orderId": {"type": "string"}},
                       "required": ["orderId"], "additionalProperties": False},
    },
}]
SYSTEM_PROMPT = (
    "你是售后查询助手。必须通过 get_order 查询订单后回答，金额字段 paidAmountYuan 的单位为元。"
    "资料不足时说明缺少什么，不猜测，不承诺退款批准或到账。"
)


def build_tool_message(result, variant):
    """故意设置的错误：把已经以元保存的金额又除以 100，只修改副本。"""
    payload = deepcopy(result)
    if variant == "wrong-unit" and payload.get("order") is not None:
        amount = payload["order"]["paidAmountYuan"] / 100
        # JavaScript 的 35 序列化为 35，Python 除法得到 35.0；整值转成 int 保持消息一致。
        payload["order"]["paidAmountYuan"] = int(amount) if amount.is_integer() else amount
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class TracedAgentService:
    def __init__(self, model, trace):
        self.model, self.trace = model, trace

    def run(self, inputs, orders, variant):
        """用户问题与身份交给应用，订单供工具查询；评分参考不交给答题模型。"""
        tool_calls = []
        messages = [{"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": inputs["turns"][0]}]
        try:
            # 最多 4 轮模型请求，最多 6 次真实工具执行，避免无限循环。
            for _round in range(4):
                message = self.model.complete("agent", {"messages": messages, "tools": TOOLS})
                if not message.get("tool_calls"):
                    return {"origin": "live", "status": "completed",
                            "answer": message.get("content") or "", "toolCalls": tool_calls}
                messages.append({"role": "assistant", "content": message.get("content"),
                                 "tool_calls": message["tool_calls"]})
                for call in message["tool_calls"]:
                    if call["type"] != "function":
                        raise ValueError("本例只支持 Function Tool。")
                    raw_args = call["function"]["arguments"]
                    try:
                        args = parse_json(raw_args)
                    except (ValueError, TypeError):
                        # 保留非法参数，工具的业务错误同样记录并回传模型。
                        args = raw_args

                    def execute():
                        if len(tool_calls) >= 6:
                            raise ValueError("工具调用次数达到本例上限。")
                        record = self.trace.capture("get_order", "tool", {
                            "toolCallId": call["id"], "name": call["function"]["name"],
                            "args": args, "context": inputs["context"],
                        }, lambda: execute_order_tool(call["function"]["name"], args, inputs["context"], orders))
                        tool_calls.append(record)
                        return record

                    record = execute()
                    # 模型只请求一次，但应用主动再执行一次；两条工具 Span 共享同一个调用 ID。
                    if variant == "repeat" and record["result"]["found"]:
                        record = execute()
                    # 单独记录数据转换，才能发现“查询正确，组装消息时改错”的问题。
                    content = self.trace.capture("build_tool_message", "transform", {
                        "toolCallId": call["id"], "result": record["result"],
                    }, lambda: build_tool_message(record["result"], variant))
                    messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
            raise ValueError("模型调用轮次达到本例上限。")
        except Exception as error:
            # 函数正常返回 error 结构时，其父 Span 是 completed；业务是否成功看 run/evaluation。
            return {"origin": "live", "status": "error", "answer": "",
                    "toolCalls": tool_calls, "error": str(error)}
