"""真实数据查询 → 文字流 → 单并发逐句合成；由 turnId 与取消信号阻止迟到结果。"""

import asyncio
import inspect
import sys
from contextlib import aclosing
from pathlib import Path

from .model import AnalysisModel
from .sentences import SentenceBuffer
from .tts import synthesize


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "07-voice-interaction"))
from analysis import execute_in_sandbox, load_dataset  # noqa: E402
from speech import trim_text, utf16_length  # noqa: E402


dependencies = {"load": load_dataset, "model": AnalysisModel,
                "execute": execute_in_sandbox, "speak": synthesize}


async def invoke(function, *args):
    """同步数据读取/Docker 放到工作线程，不能阻塞网关处理停止事件。"""
    if inspect.iscoroutinefunction(function):
        return await function(*args)
    result = await asyncio.to_thread(function, *args)
    return await result if inspect.isawaitable(result) else result


class VoiceService:
    async def answer(self, turn, question, mode, deps=None):
        deps = dependencies if deps is None else deps
        signal = turn.signal
        model = deps["model"]()
        turn.send("status", {"text": "正在准备查询"})
        dataset = await invoke(deps["load"])
        signal.throw_if_aborted()

        decision = await model.decide(question, dataset["context"], signal)
        signal.throw_if_aborted()
        if decision["action"] == "clarify":
            turn.send("answer.delta", {"text": decision["question"]})
            turn.send("done")
            return

        turn.send("status", {"text": "正在执行受限查询"})
        # 既有执行器不接取消信号；等待它自身结束与清理，再检查轮次。
        result = await invoke(deps["execute"], dataset["databasePath"], decision["sql"])
        signal.throw_if_aborted()
        turn.send("query.result", {"sql": decision["sql"], "rows": result["rows"],
                                  "metric": decision["metric"], "scope": decision["scope"]})
        if not result["rows"]:
            turn.send("answer.delta", {"text": "没有符合条件的记录，空结果不代表销售额为零。"})
            turn.send("done")
            return

        turn.send("status", {"text": "正在生成回答与语音"})
        sentences = SentenceBuffer()
        answer, sequence = "", 0
        synthesis = asyncio.get_running_loop().create_future()
        synthesis.set_result(None)

        async def segment(previous, text, seq):
            try:
                # 后一句等待前一句，文字流仍可继续；失败也不阻塞后续段。
                await previous
                signal.throw_if_aborted()
                audio_url = await invoke(deps["speak"], text, signal)
                signal.throw_if_aborted()
                turn.send("audio.segment", {"seq": seq, "text": text, "audioUrl": audio_url})
            except Exception as error:
                if not signal.aborted:
                    turn.send("audio.warning", {"text": f"第 {seq + 1} 段合成失败：{error}"})

        def enqueue(text):
            nonlocal sequence, synthesis
            seq = sequence
            sequence += 1
            if seq >= 24:
                raise ValueError("回答分段过多，已停止本轮")
            synthesis = asyncio.create_task(segment(synthesis, text, seq))

        try:
            # aclosing 确保长度错误/取消时也调用生成器 finally，关闭 SSE 连接。
            async with aclosing(model.explain(question, dataset["context"], decision, result, signal)) as stream:
                async for delta in stream:
                    signal.throw_if_aborted()
                    answer += delta
                    if utf16_length(answer) > 600:
                        raise ValueError("回答超过本例长度上限")
                    if mode == "stream":
                        turn.send("answer.delta", {"text": delta})
                        for sentence in sentences.push(delta):
                            enqueue(sentence)
                        # 给合成队列一次调度机会；即使 Fake 生成器不等待网络，也不独占事件循环。
                        await asyncio.sleep(0)

            signal.throw_if_aborted()
            if not trim_text(answer):
                raise ValueError("模型返回了空回答")
            if mode == "buffered":
                turn.send("answer.delta", {"text": answer})
                enqueue(answer)
            else:
                for sentence in sentences.flush():
                    enqueue(sentence)
            turn.send("text.done")
            await synthesis
            signal.throw_if_aborted()
            turn.send("done")
        except Exception as error:
            # 已显示文字保留为部分结果；取消未完成合成并等待其清理，不冒充成功。
            turn.send("error", {"text": str(error)})
            turn.cancel()
            await synthesis
            raise
