import asyncio
import json
import unittest

from deepseek_client import call_deepseek
from incident_data import get_incident_scenario
from incident_tools import create_incident_toolset
from react_agent import run_react_agent


GOAL = "payment-service 从 15:10 开始出现大量支付失败。"


def tool_call(call_id, name, arguments):
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(arguments, ensure_ascii=False)
            if not isinstance(arguments, str)
            else arguments,
        },
    }


class IncidentDataTest(unittest.TestCase):
    def test_reads_known_scenario(self):
        scenario = get_incident_scenario("release-regression")

        self.assertEqual(scenario["serviceName"], "payment-service")
        self.assertEqual(scenario["health"]["http5xxRate"], 31.8)
        self.assertEqual(scenario["deployments"]["items"][0]["version"], "v2.4.1")

    def test_rejects_unknown_scenario(self):
        with self.assertRaisesRegex(ValueError, "未知场景"):
            get_incident_scenario("missing")


class IncidentToolsTest(unittest.TestCase):
    def test_exposes_readonly_tool_definitions(self):
        toolset = create_incident_toolset("release-regression")
        tool_names = [item["function"]["name"] for item in toolset["tools"]]

        self.assertEqual(
            tool_names,
            [
                "get_service_health",
                "query_metrics",
                "query_logs",
                "get_recent_deployments",
                "inspect_database_pool",
            ],
        )
        self.assertEqual(
            toolset["tools"][0]["function"]["parameters"]["required"],
            ["serviceName"],
        )

    def test_executes_valid_tool_call(self):
        toolset = create_incident_toolset("release-regression")
        observation = asyncio.run(
            toolset["executeToolCall"](
                tool_call("call-1", "query_logs", {"serviceName": "payment-service"})
            )
        )

        self.assertTrue(observation["ok"])
        self.assertEqual(observation["source"], "query_logs")
        self.assertEqual(
            observation["data"]["topErrors"][0]["code"],
            "PAYMENT_CURRENCY_UNDEFINED",
        )

    def test_returns_structured_tool_errors(self):
        toolset = create_incident_toolset("release-regression")

        invalid_json = asyncio.run(
            toolset["executeToolCall"](tool_call("call-1", "query_logs", "{bad-json"))
        )
        missing_service = asyncio.run(
            toolset["executeToolCall"](tool_call("call-2", "query_logs", {}))
        )
        wrong_service = asyncio.run(
            toolset["executeToolCall"](
                tool_call("call-3", "query_logs", {"serviceName": "unknown-service"})
            )
        )
        unknown_tool = asyncio.run(
            toolset["executeToolCall"](
                tool_call("call-4", "restart_service", {"serviceName": "payment-service"})
            )
        )

        self.assertEqual(invalid_json["error"]["code"], "INVALID_JSON_ARGUMENTS")
        self.assertEqual(missing_service["error"]["code"], "INVALID_TOOL_ARGUMENTS")
        self.assertEqual(wrong_service["error"]["code"], "SERVICE_NOT_FOUND")
        self.assertEqual(unknown_tool["error"]["code"], "TOOL_NOT_FOUND")


class ReactAgentTest(unittest.TestCase):
    def test_runs_release_regression_route(self):
        toolset = create_incident_toolset("release-regression")
        tool_names = [
            "get_service_health",
            "query_metrics",
            "query_logs",
            "get_recent_deployments",
        ]
        seen_message_lengths = []

        async def fake_model(messages, tools):
            seen_message_lengths.append(len(messages))
            index = len(seen_message_lengths) - 1

            if index < len(tool_names):
                return {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            tool_call(
                                f"call-{index}",
                                tool_names[index],
                                {"serviceName": "payment-service"},
                            )
                        ],
                    },
                    "finishReason": "tool_calls",
                    "latencyMs": 1,
                }

            return {
                "message": {
                    "content": "最可能原因是 v2.4.1 发布引入的币种字段读取问题。"
                },
                "finishReason": "stop",
                "latencyMs": 1,
            }

        result = asyncio.run(
            run_react_agent(
                goal=GOAL,
                tools=toolset["tools"],
                execute_tool_call=toolset["executeToolCall"],
                call_model=fake_model,
            )
        )

        self.assertEqual(
            [item["action"]["toolName"] for item in result["trajectory"]],
            tool_names,
        )
        self.assertEqual(seen_message_lengths, [2, 4, 6, 8, 10])
        self.assertIn("v2.4.1", result["finalAnswer"])

    def test_runs_database_pool_route(self):
        toolset = create_incident_toolset("database-pool")
        tool_names = [
            "get_service_health",
            "query_metrics",
            "query_logs",
            "inspect_database_pool",
        ]

        async def fake_model(messages, tools):
            index = (len(messages) - 2) // 2

            if index < len(tool_names):
                return {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            tool_call(
                                f"call-{index}",
                                tool_names[index],
                                {"serviceName": "payment-service"},
                            )
                        ],
                    },
                    "finishReason": "tool_calls",
                    "latencyMs": 1,
                }

            return {
                "message": {
                    "content": "最可能原因是数据库连接池被长期查询占满。"
                },
                "finishReason": "stop",
                "latencyMs": 1,
            }

        result = asyncio.run(
            run_react_agent(
                goal=GOAL,
                tools=toolset["tools"],
                execute_tool_call=toolset["executeToolCall"],
                call_model=fake_model,
            )
        )

        self.assertEqual(
            [item["action"]["toolName"] for item in result["trajectory"]],
            tool_names,
        )
        self.assertEqual(
            result["trajectory"][-1]["observation"]["data"]["waitingRequests"],
            47,
        )


class DeepSeekClientTest(unittest.TestCase):
    def test_builds_deepseek_request(self):
        captured = {}

        def transport(api_url, headers, payload):
            captured["api_url"] = api_url
            captured["headers"] = headers
            captured["payload"] = payload

            return 200, {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "完成",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"total_tokens": 12},
            }

        result = asyncio.run(
            call_deepseek(
                messages=[{"role": "user", "content": "hello"}],
                tools=[],
                env={
                    "DEEPSEEK_API_KEY": "sk-test",
                    "DEEPSEEK_BASE_URL": "https://example.test/chat/completions",
                    "DEEPSEEK_MODEL": "deepseek-test",
                },
                transport=transport,
            )
        )

        self.assertEqual(captured["api_url"], "https://example.test/chat/completions")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer sk-test")
        self.assertEqual(captured["payload"]["model"], "deepseek-test")
        self.assertEqual(captured["payload"]["tool_choice"], "auto")
        self.assertEqual(captured["payload"]["thinking"], {"type": "disabled"})
        self.assertEqual(captured["payload"]["temperature"], 0.1)
        self.assertEqual(result["finishReason"], "stop")
        self.assertEqual(result["usage"], {"total_tokens": 12})

    def test_requires_api_key(self):
        with self.assertRaisesRegex(RuntimeError, "缺少 DEEPSEEK_API_KEY"):
            asyncio.run(call_deepseek(messages=[], tools=[], env={}))
