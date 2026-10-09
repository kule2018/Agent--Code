"""语音和键盘输入共用文字分析入口；复用 Python 04 的决策与 Python 05 的容器。"""

import sys
from pathlib import Path

from speech import character_count


CHAPTER_DIR = Path(__file__).resolve().parent.parent
# 小节不是 Python 包；按源码位置导入，不依赖启动目录，也不读取其他语言目录。
sys.path.insert(0, str(CHAPTER_DIR / "04-text-to-sql"))
sys.path.insert(0, str(CHAPTER_DIR / "05-restricted-execution"))
from dataset import load_dataset  # noqa: E402
from model import create_ai_provider  # noqa: E402
from text_to_sql import answer_question  # noqa: E402
from sandbox import run_sandbox  # noqa: E402


def execute_in_sandbox(database_path, sql):
    """受限容器执行 SQL；权限/超时/清理失败不触发反复尝试。"""
    execution = run_sandbox({"kind": "sql", "sql": sql}, database_path=database_path)
    if execution["status"] != "completed" or not execution.get("cleanedUp"):
        raise RuntimeError(execution.get("error") or "查询未完成，或容器清理未完成。")
    return {"rows": execution["result"]["rows"], "truncated": False}


def select_speech_text(report):
    """短回答直接朗读；长回答提示查看全文，不截断数字或统计限制。"""
    if report["status"] in {"failed", "explanation_failed"}:
        return "本次分析没有完整完成，请查看页面上的错误信息和已有查询结果。"
    if character_count(report["answer"]) <= 500:
        return report["answer"]
    return "本次回答较长，完整结论和查询结果已经展示在页面上，请查看文字内容。"


def analyze(question, *, dataset=None, provider=None, execute=None):
    """问题 → 决策 → 容器内 SQL → 根据真实结果回答 → 页面与朗读共用的 DTO。"""
    dataset = load_dataset() if dataset is None else dataset
    provider = create_ai_provider() if provider is None else provider
    report = answer_question(question, dataset, provider,
                             execute_in_sandbox if execute is None else execute)
    last = report["attempts"][-1]["decision"] if report["attempts"] else {}
    return {
        "status": report["status"], "answer": report["answer"],
        "speechText": select_speech_text(report),
        # 保留最后一次实际 SQL、查询结果、统计口径和数据版本，便于回查。
        "sql": last.get("sql") or "", "rows": (report.get("result") or {}).get("rows") or [],
        "warning": report.get("warning") or "", "datasetId": report["datasetId"],
        "version": report["version"], "metric": last.get("metric") or "",
        "scope": last.get("scope") or "",
    }
