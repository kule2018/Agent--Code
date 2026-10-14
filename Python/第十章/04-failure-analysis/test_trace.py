"""离线测试：合成订单、假模型响应与本地 HTTP，不加载环境文件或真实密钥。"""

import asyncio
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
from unittest.mock import patch
from urllib.error import URLError
from uuid import UUID

from inspect_trace import inspect_report
import inspect_trace
from main import main, run_experiment
from report import print_report, summarize
from scoring import EvaluationService, load_case
from trace_service import TraceService, round_ms
from traced_agent_service import TracedAgentService, build_tool_message
from traced_model_service import TracedModelService


CASE = load_case()
SAMPLE, FIXTURE = CASE["sample"], CASE["fixture"]
TEST_KEY = "test-secret-not-for-traces"
USAGE = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}


def assistant(content, tool_calls=None):
    return {"role": "assistant", "content": content, **({"tool_calls": tool_calls} if tool_calls is not None else {})}


def order_call(arguments='{"orderId":"A1024"}', *, identity="call-test-1", name="get_order"):
    return {"id": identity, "type": "function", "function": {"name": name, "arguments": arguments}}


def completion(message, *, reason=None, usage=USAGE):
    return {"id": "test-completion", "object": "chat.completion", "created": 0,
            "model": "http-test-model", "choices": [{"index": 0, "message": message,
                "finish_reason": reason or ("tool_calls" if message.get("tool_calls") else "stop")}], "usage": usage}


class Responses:
    """人工设定的响应，仅验证应用处理流程；不是实际模型或语义评分器。"""
    def __init__(self, *, wrong_order=False, fail_role="", usage=USAGE, override=None):
        self.wrong_order, self.fail_role, self.usage, self.override = wrong_order, fail_role, usage, override
        self.calls = []

    def reply(self, body):
        role = "judge" if body.get("response_format") else "agent"
        if role == self.fail_role:
            raise RuntimeError("测试用上游不可用")
        if self.override is not None:
            return self.override(role, body)
        if role == "judge":
            answer = json.loads(body["messages"][-1]["content"])["answer"]
            message = assistant(json.dumps({"score": 2 if answer == "订单 A1024 的实付金额是 3500 元。" else 0,
                "reason": "测试替身按本样本确定性核对金额。", "quotes": [answer]}, ensure_ascii=False))
        else:
            tools = [item for item in body["messages"] if item["role"] == "tool"]
            if tools:
                order = json.loads(tools[-1]["content"]).get("order")
                message = assistant(f"订单 {order['orderId']} 的实付金额是 {order['paidAmountYuan']} 元。"
                                    if order else "未查到订单。")
            else:
                message = assistant(None, [order_call(json.dumps({"orderId": "A9999" if self.wrong_order else "A1024"}))])
        return completion(message, usage=self.usage)

    def open(self, request, *, timeout):
        body = json.loads(request.data.decode("utf-8"))
        self.calls.append({"body": deepcopy(body), "timeout": timeout,
                           "url": request.full_url, "headers": dict(request.header_items()), "method": request.method})
        return io.BytesIO(json.dumps(self.reply(body), ensure_ascii=False).encode("utf-8"))

    def model(self, trace):
        return TracedModelService(trace, environment={"DEEPSEEK_API_KEY": TEST_KEY,
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:1/v1", "DEEPSEEK_MODEL": "http-test-model",
            "JUDGE_MODEL": "http-test-judge"}, open_request=self.open)


class LocalAPI:
    def __init__(self, responses):
        self.responses = responses
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append({"body": body, "path": self.path,
                                       "authorization": self.headers.get("Authorization")})
                try:
                    status, response = 200, owner.responses.reply(body)
                except RuntimeError:
                    status, response = 503, {"error": {"message": "测试用上游不可用", "type": "server_error"}}
                data = json.dumps(response, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def model(self, trace):
        return TracedModelService(trace, environment={"DEEPSEEK_API_KEY": TEST_KEY,
            "DEEPSEEK_BASE_URL": f"http://127.0.0.1:{self.server.server_port}/v1/",
            "DEEPSEEK_MODEL": "http-test-model", "JUDGE_MODEL": "http-test-judge"})


def execute(variant, responses=None, *, api=None):
    trace = TraceService()
    responses = Responses() if responses is None else responses
    model = responses.model(trace) if api is None else api.model(trace)
    run = trace.capture("agent.run", "agent", {"inputs": SAMPLE["inputs"], "variant": variant},
        lambda: TracedAgentService(model, trace).run(deepcopy(SAMPLE["inputs"]), deepcopy(FIXTURE["orders"]), variant))
    evaluation = trace.capture("evaluation.run", "evaluation", {"sample": SAMPLE, "run": run},
        lambda: EvaluationService(model).evaluate(SAMPLE, run))
    return trace, run, evaluation


class TransformAndTraceTests(unittest.TestCase):
    def test_conversion_and_source_isolation(self):
        result = {"found": True, "order": deepcopy(FIXTURE["orders"][0])}
        before = deepcopy(result)
        value = build_tool_message(result, "wrong-unit")
        self.assertEqual(json.loads(value)["order"]["paidAmountYuan"], 35)
        self.assertIn('"paidAmountYuan":35}', value)
        self.assertEqual(result, before)
        for variant in ("fixed", "repeat"):
            self.assertEqual(json.loads(build_tool_message(result, variant)), result)

    def test_transform_missing_order_and_non_integer_amount(self):
        self.assertEqual(json.loads(build_tool_message({"found": False}, "wrong-unit")), {"found": False})
        result = {"found": True, "order": {**FIXTURE["orders"][0], "paidAmountYuan": 3501}}
        self.assertEqual(json.loads(build_tool_message(result, "wrong-unit"))["order"]["paidAmountYuan"], 35.01)

    def test_input_output_snapshot_and_parent(self):
        trace = TraceService()
        messages, result = [{"role": "user", "content": "查询"}], {"amount": 3500}
        actual = trace.capture("parent", "agent", {},
            lambda: trace.capture("child", "tool", {"messages": messages}, lambda: result))
        self.assertIs(actual, result)
        messages.append({"role": "assistant", "content": "后加的消息"})
        result["amount"] = 1
        self.assertEqual(trace.spans[1]["parentId"], trace.spans[0]["id"])
        self.assertEqual(len(trace.spans[1]["input"]["messages"]), 1)
        self.assertEqual(trace.spans[1]["output"], {"amount": 3500})

    def test_snapshot_copy_and_unique_ids(self):
        trace = TraceService()
        trace.capture("root", "agent", {}, lambda: True)
        snapshot = trace.snapshot()
        snapshot["spans"][0]["status"] = "changed"
        self.assertEqual(trace.spans[0]["status"], "completed")
        self.assertEqual(str(UUID(trace.trace_id)), trace.trace_id)
        self.assertNotEqual(trace.spans[0]["id"], trace.trace_id)

    def test_running_state_duration_and_rounding(self):
        trace = TraceService()

        def operation():
            self.assertEqual(trace.spans[0]["status"], "running")
            self.assertNotIn("output", trace.spans[0])
            return True

        with patch("trace_service.perf_counter", side_effect=[1, 1.125]):
            trace.capture("test", "tool", {}, operation)
        self.assertEqual(trace.spans[0]["durationMs"], 125)
        self.assertEqual(round_ms(1.125), 1.13)
        self.assertEqual(round_ms(2.5, 0), 3)

    def test_exception_propagates_and_parent_restored(self):
        trace = TraceService()

        def failed():
            raise RuntimeError("测试超时")

        with self.assertRaisesRegex(RuntimeError, "测试超时"):
            trace.capture("parent", "agent", {}, lambda: trace.capture("child", "tool", {}, failed))
        for span in trace.spans:
            self.assertEqual(span["status"], "error")
            self.assertEqual(span["error"], "测试超时")
            self.assertNotIn("output", span)
            self.assertGreaterEqual(span["durationMs"], 0)
        trace.capture("next", "agent", {}, lambda: True)
        self.assertIsNone(trace.spans[-1]["parentId"])


class ConcurrentTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_parent_isolation(self):
        trace = TraceService()

        async def operation(name):
            await asyncio.sleep(0)
            return await trace.capture_async(f"{name}.child", "tool", {}, lambda: True)

        await asyncio.gather(*(trace.capture_async(name, "agent", {}, lambda name=name: operation(name))
                               for name in ("a", "b")))
        by_name = {span["name"]: span for span in trace.spans}
        for name in ("a", "b"):
            self.assertIsNone(by_name[name]["parentId"])
            self.assertEqual(by_name[f"{name}.child"]["parentId"], by_name[name]["id"])

    async def test_async_error_and_cancellation_restore_context(self):
        trace = TraceService()

        async def cancelled():
            raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await trace.capture_async("cancelled", "agent", {}, cancelled)
        self.assertEqual(trace.spans[0]["status"], "error")
        await trace.capture_async("next", "agent", {}, lambda: True)
        self.assertIsNone(trace.spans[1]["parentId"])


class ExperimentTests(unittest.TestCase):
    def test_wrong_unit_records_actual_input_change_and_failed_content(self):
        trace, run, evaluation = execute("wrong-unit")
        self.assertEqual(run["toolCalls"][0]["result"]["order"]["paidAmountYuan"], 3500)
        self.assertEqual(run["answer"], "订单 A1024 的实付金额是 35 元。")
        self.assertEqual(evaluation["status"], "failed")
        self.assertTrue(all(rule["passed"] for rule in evaluation["rules"]))
        models = [span for span in trace.spans if span["name"] == "agent.model"]
        self.assertEqual(len(models[0]["input"]["messages"]), 2)
        self.assertEqual([m["role"] for m in models[1]["input"]["messages"]], ["system", "user", "assistant", "tool"])
        self.assertNotIn("3500", json.dumps(models[0]["input"]["messages"]))
        self.assertEqual(json.loads(models[1]["input"]["messages"][-1]["content"])["order"]["paidAmountYuan"], 35)
        transform = next(span for span in trace.spans if span["kind"] == "transform")
        self.assertEqual(transform["input"]["result"]["order"]["paidAmountYuan"], 3500)
        self.assertEqual(json.loads(transform["output"])["order"]["paidAmountYuan"], 35)
        self.assertEqual(summarize(trace.spans, "agent")["totalTokens"], 240)
        self.assertEqual(summarize(trace.spans, "judge")["totalTokens"], 120)
        self.assertNotIn(TEST_KEY, json.dumps(trace.snapshot()))

    def test_fixed_preserves_amount_and_same_evaluator_passes(self):
        trace, run, evaluation = execute("fixed")
        self.assertEqual(run["answer"], "订单 A1024 的实付金额是 3500 元。")
        self.assertEqual(evaluation["status"], "passed")
        transform = next(span for span in trace.spans if span["kind"] == "transform")
        self.assertEqual(json.loads(transform["output"]), transform["input"]["result"])

    def test_repeat_is_application_execution_not_two_model_requests(self):
        trace, run, evaluation = execute("repeat")
        self.assertEqual(len(run["toolCalls"]), 2)
        self.assertEqual(evaluation["status"], "passed")
        calls = [span for span in trace.spans if span["kind"] == "tool"]
        self.assertEqual(calls[0]["input"], calls[1]["input"])
        self.assertEqual(calls[0]["output"], calls[1]["output"])
        models = [span for span in trace.spans if span["name"] == "agent.model"]
        self.assertEqual(len(models[0]["output"]["message"]["tool_calls"]), 1)
        self.assertEqual(sum(message["role"] == "tool" for message in models[1]["input"]["messages"]), 1)

    def test_wrong_order_skips_judge_and_repeat_not_found_only_executes_once(self):
        for variant in ("fixed", "repeat"):
            with self.subTest(variant=variant):
                trace, run, evaluation = execute(variant, Responses(wrong_order=True))
                self.assertEqual(evaluation["status"], "failed")
                self.assertEqual(evaluation["judge"]["status"], "skipped")
                self.assertEqual(summarize(trace.spans, "judge")["modelCalls"], 0)
                self.assertEqual(len(run["toolCalls"]), 1)

    def test_agent_and_judge_failures_are_distinct(self):
        for role, status in (("agent", "agent_error"), ("judge", "evaluation_error")):
            with self.subTest(role=role):
                trace, run, evaluation = execute("fixed", Responses(fail_role=role))
                self.assertEqual(evaluation["status"], status)
                failed = next(span for span in trace.spans if span["name"] == f"{role}.model")
                self.assertEqual(failed["status"], "error")
                self.assertEqual(failed["error"], "测试用上游不可用")
                self.assertIsNone(summarize(trace.spans, role)["totalTokens"])
                self.assertEqual(trace.spans[0]["status"], "completed")
                self.assertEqual(trace.spans[-2 if role == 'judge' else -1]["status"], "completed")
                self.assertEqual(run["status"], "error" if role == "agent" else "completed")

    def test_every_child_has_expected_parent(self):
        trace, _, _ = execute("fixed")
        roots = {span["name"]: span for span in trace.spans if span["parentId"] is None}
        self.assertEqual(set(roots), {"agent.run", "evaluation.run"})
        for span in trace.spans:
            if span["parentId"] is not None:
                expected = roots["evaluation.run" if span["name"] == "judge.model" else "agent.run"]["id"]
                self.assertEqual(span["parentId"], expected)

    def test_bad_arguments_are_business_error_not_thrown_tool_exception(self):
        def reply(role, body):
            if role == "agent" and len(body["messages"]) == 2:
                return completion(assistant(None, [order_call("not-json")]))
            return completion(assistant("未查到订单。"))

        trace, run, evaluation = execute("fixed", Responses(override=reply))
        self.assertEqual(evaluation["status"], "failed")
        tool = next(span for span in trace.spans if span["kind"] == "tool")
        self.assertEqual(tool["input"]["args"], "not-json")
        self.assertEqual(tool["status"], "completed")
        self.assertIn("参数", run["toolCalls"][0]["result"]["error"])

    def test_four_model_round_limit(self):
        responses = Responses(override=lambda *_: completion(assistant(None, [order_call()])))
        trace, run, evaluation = execute("fixed", responses)
        self.assertEqual(run["error"], "模型调用轮次达到本例上限。")
        self.assertEqual(len(run["toolCalls"]), 4)
        self.assertEqual(summarize(trace.spans, "agent")["modelCalls"], 4)
        self.assertEqual(evaluation["status"], "agent_error")

    def test_six_execution_limit_including_repeat(self):
        for variant in ("fixed", "repeat"):
            with self.subTest(variant=variant):
                responses = Responses(override=lambda *_: completion(assistant(None,
                    [order_call(identity=f"call-{i}") for i in range(7)])))
                trace, run, evaluation = execute(variant, responses)
                self.assertEqual(run["error"], "工具调用次数达到本例上限。")
                self.assertEqual(len(run["toolCalls"]), 6)
                self.assertEqual(sum(span["kind"] == "tool" for span in trace.spans), 6)
                self.assertEqual(evaluation["status"], "agent_error")

    def test_unsupported_tool_and_transform_exception(self):
        responses = Responses(override=lambda *_: completion(assistant(None, [{**order_call(), "type": "custom"}])))
        trace, run, _ = execute("fixed", responses)
        self.assertEqual(run["error"], "本例只支持 Function Tool。")
        self.assertFalse(any(span["kind"] == "tool" for span in trace.spans))
        with patch("traced_agent_service.build_tool_message", side_effect=RuntimeError("测试转换异常")):
            trace, run, evaluation = execute("fixed")
        self.assertEqual(len(run["toolCalls"]), 1)
        self.assertEqual(evaluation["status"], "agent_error")
        transform = next(span for span in trace.spans if span["kind"] == "transform")
        self.assertEqual(transform["error"], "测试转换异常")
        self.assertNotIn("output", transform)


class ModelAndUsageTests(unittest.TestCase):
    def test_configuration_and_defaults_before_trace(self):
        trace = TraceService()
        model = TracedModelService(trace, environment={}, open_request=lambda *_: self.fail("不能发请求"))
        self.assertEqual(model.settings(), {"agent": "deepseek-flash", "judge": "deepseek-flash"})
        with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
            model.complete("agent", {"messages": []})
        self.assertEqual(trace.spans, [])

    def test_request_fields_snapshot_usage_and_key_not_in_trace(self):
        trace, responses = TraceService(), Responses()
        request = {"messages": [{"role": "user", "content": "查询"}], "headers": {"Authorization": TEST_KEY}}
        reply = responses.model(trace).complete("agent", request)
        request["messages"].append({"role": "user", "content": "后追加"})
        reply["content"] = "改动返回对象"
        span = trace.spans[0]
        self.assertEqual(len(span["input"]["messages"]), 1)
        self.assertNotIn("headers", span["input"])
        self.assertIsNone(span["output"]["message"]["content"])
        self.assertEqual(span["output"]["usage"], USAGE)
        self.assertNotIn(TEST_KEY, json.dumps(trace.snapshot()))
        wire = responses.calls[0]
        self.assertEqual(wire["body"], span["input"])
        self.assertEqual(wire["timeout"], 45)
        self.assertEqual(wire["method"], "POST")
        self.assertEqual(wire["url"], "http://127.0.0.1:1/v1/chat/completions")

    def test_truncation_is_captured_then_agent_error(self):
        for reason in ("length", "content_filter", "aborted", "insufficient_system_resource"):
            with self.subTest(reason=reason):
                trace, run, evaluation = execute("fixed", Responses(override=lambda *_:
                    completion(assistant("未完整返回"), reason=reason)))
                model = next(span for span in trace.spans if span["name"] == "agent.model")
                self.assertEqual(model["status"], "completed")
                self.assertEqual(model["output"]["finishReason"], reason)
                self.assertEqual(run["error"], f"模型没有完整返回：{reason}")
                self.assertEqual(evaluation["status"], "agent_error")

    def test_empty_choices_retained_in_trace(self):
        trace, run, _ = execute("fixed", Responses(override=lambda *_:
            {"model": "test", "choices": [], "usage": None}))
        self.assertEqual(run["error"], "模型没有完整返回：empty_choices")
        model = next(span for span in trace.spans if span["name"] == "agent.model")
        self.assertIsNone(model["output"]["message"])
        self.assertIsNone(model["output"]["finishReason"])
        self.assertIsNone(summarize(trace.spans, "agent")["totalTokens"])

    def test_network_and_invalid_response_not_retried(self):
        for failure in (URLError("测试连接失败"), TimeoutError("测试超时")):
            trace, calls = TraceService(), []

            def unavailable(request, *, timeout):
                calls.append(timeout)
                raise failure

            model = TracedModelService(trace, environment={"DEEPSEEK_API_KEY": TEST_KEY}, open_request=unavailable)
            with self.assertRaises(RuntimeError):
                model.complete("agent", {"messages": []})
            self.assertEqual(calls, [45])
            self.assertEqual(trace.spans[0]["status"], "error")
        trace = TraceService()
        model = TracedModelService(trace, environment={"DEEPSEEK_API_KEY": TEST_KEY},
                                  open_request=lambda *_args, **_kwargs: io.BytesIO(b"not-json"))
        with self.assertRaises(ValueError):
            model.complete("agent", {"messages": []})
        self.assertEqual(trace.spans[0]["status"], "error")

    def test_usage_unknown_or_zero_and_do_not_add_parent_duration(self):
        trace = TraceService()
        trace.capture("agent.run", "agent", {}, lambda:
            trace.capture("agent.model", "model", {}, lambda: {"usage": None}))
        self.assertIsNone(summarize(trace.spans, "agent")["totalTokens"])
        self.assertEqual(summarize(trace.spans, "agent")["missingUsageCalls"], 1)
        self.assertEqual(summarize(trace.spans, "judge")["totalTokens"], 0)
        self.assertEqual(summarize(trace.spans, "judge")["modelCalls"], 0)
        trace.spans[0]["durationMs"], trace.spans[1]["durationMs"] = 100, 2.5
        self.assertEqual(summarize(trace.spans, "agent")["modelMs"], 3)

    def test_partial_usage_makes_all_totals_unknown(self):
        for usage in (None, {}, {"prompt_tokens": 100}, {**USAGE, "total_tokens": "120"},
                      {**USAGE, "completion_tokens": True}):
            trace = TraceService()
            trace.capture("agent.model", "model", {}, lambda: {"usage": USAGE})
            trace.capture("agent.model", "model", {}, lambda: {"usage": usage})
            result = summarize(trace.spans, "agent")
            self.assertEqual(result["missingUsageCalls"], 1)
            self.assertTrue(all(result[key] is None for key in ("inputTokens", "outputTokens", "totalTokens")))

    def test_local_http_three_variants_and_request_contract(self):
        with LocalAPI(Responses()) as api:
            for variant, status in (("wrong-unit", "failed"), ("fixed", "passed"), ("repeat", "passed")):
                trace, _, evaluation = execute(variant, api=api)
                self.assertEqual(evaluation["status"], status)
                self.assertNotIn(TEST_KEY, json.dumps(trace.snapshot()))
            self.assertEqual(len(api.requests), 9)
            for index, request in enumerate(api.requests):
                body = request["body"]
                self.assertEqual(request["path"], "/v1/chat/completions")
                self.assertEqual(request["authorization"], f"Bearer {TEST_KEY}")
                self.assertEqual(body["thinking"], {"type": "disabled"})
                self.assertIs(body["stream"], False)
                self.assertEqual(body["max_tokens"], 1600)
                self.assertEqual(body["temperature"], 0)
                if index % 3 == 2:
                    self.assertEqual(body["model"], "http-test-judge")
                    self.assertEqual(body["response_format"], {"type": "json_object"})
                    self.assertNotIn("tools", body)

    def test_local_http_failure_records_status_and_no_retry(self):
        for role, status in (("agent", "agent_error"), ("judge", "evaluation_error")):
            with self.subTest(role=role), LocalAPI(Responses(fail_role=role)) as api:
                trace, _, evaluation = execute("fixed", api=api)
                self.assertEqual(evaluation["status"], status)
                span = next(span for span in trace.spans if span["name"] == f"{role}.model")
                self.assertEqual(span["status"], "error")
                self.assertEqual(span["error"], "模型请求失败：HTTP 503")
                self.assertEqual(len(api.requests), 1 if role == "agent" else 3)


class FileAndEntryTests(unittest.TestCase):
    def test_three_histories_latest_and_offline_inspect(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory, reports = Path(temporary) / "outputs", []
            for variant in ("wrong-unit", "fixed", "repeat"):
                trace, responses = TraceService(), Responses()
                with redirect_stdout(io.StringIO()):
                    code = run_experiment(variant, trace=trace, model=responses.model(trace), output_directory=directory)
                self.assertEqual(code, 0)
                history = directory / f"{variant}-{trace.trace_id}.json"
                report = json.loads(history.read_text(encoding="utf-8"))
                reports.append(report)
                self.assertEqual(report, json.loads((directory / "latest.json").read_text(encoding="utf-8")))
                self.assertEqual(report["schemaVersion"], 1)
                self.assertEqual(report["caseId"], "order-amount")
                self.assertEqual(report["datasetVersion"], CASE["datasetVersion"])
                self.assertEqual(report["fixtureId"], FIXTURE["id"])
                self.assertEqual(report["rubricVersion"], "order-answer-v1")
                self.assertNotIn(TEST_KEY, json.dumps(report))
                before = history.read_bytes()
                with redirect_stdout(io.StringIO()) as output:
                    inspected = inspect_report(history)
                self.assertEqual(inspected, report)
                self.assertEqual(history.read_bytes(), before)
                self.assertIn("组装 Tool Message 前后", output.getvalue())
            self.assertEqual(len(list(directory.glob("*.json"))), 4)
            self.assertEqual([item["evaluation"]["status"] for item in reports], ["failed", "passed", "passed"])

    def test_technical_error_still_saves_report_and_exit_one(self):
        for role, status in (("agent", "agent_error"), ("judge", "evaluation_error")):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()):
                trace, responses = TraceService(), Responses(fail_role=role)
                self.assertEqual(run_experiment("fixed", trace=trace, model=responses.model(trace),
                                                 output_directory=temporary), 1)
                report = json.loads((Path(temporary) / "latest.json").read_text(encoding="utf-8"))
                self.assertEqual(report["evaluation"]["status"], status)

    def test_invalid_variant_and_missing_key_fail_before_output(self):
        with self.assertRaisesRegex(ValueError, "实验名称"):
            run_experiment("unknown")
        with redirect_stderr(io.StringIO()) as error:
            self.assertEqual(main(["unknown"]), 1)
        self.assertIn("实验名称", error.getvalue())
        with tempfile.TemporaryDirectory() as temporary:
            trace = TraceService()
            model = TracedModelService(trace, environment={})
            output = Path(temporary) / "not-created"
            with self.assertRaisesRegex(ValueError, "DEEPSEEK_API_KEY"):
                run_experiment("fixed", model=model, trace=trace, output_directory=output)
            self.assertFalse(output.exists())

    def test_inspect_schema_errors_and_cli_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invalid.json"
            for value in ({}, {"schemaVersion": True, "spans": [], "run": {}, "evaluation": {}}, []):
                path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Trace JSON"):
                    inspect_report(path)
            trace, responses = TraceService(), Responses()
            with redirect_stdout(io.StringIO()):
                run_experiment("fixed", trace=trace, model=responses.model(trace), output_directory=temporary)
                with patch("inspect_trace.DEFAULT_PATH", Path(temporary) / "latest.json"):
                    self.assertEqual(inspect_trace.main([]), 0)

    def test_inspect_from_another_cwd_does_not_call_model(self):
        with tempfile.TemporaryDirectory() as temporary, redirect_stdout(io.StringIO()):
            trace, responses = TraceService(), Responses()
            run_experiment("fixed", trace=trace, model=responses.model(trace), output_directory=temporary)
            result = subprocess.run([sys.executable, str(Path(inspect_trace.__file__).resolve()),
                                     str(Path(temporary) / "latest.json")], cwd=temporary,
                                    capture_output=True, text=True, check=True)
            self.assertIn("评测结果：passed", result.stdout)
            self.assertIn("模型用量", result.stdout)

    def test_error_span_prints_exception_and_unknown_usage(self):
        trace, run, evaluation = execute("fixed", Responses(fail_role="agent"))
        report = {"caseId": "order-amount", "variant": "fixed", "run": run, "evaluation": evaluation, **trace.snapshot()}
        with redirect_stdout(io.StringIO()) as output:
            print_report(report)
        self.assertIn("异常步骤 agent.model：测试用上游不可用", output.getvalue())
        self.assertIn('"totalTokens": null', output.getvalue())


if __name__ == "__main__":
    unittest.main()
