"""显式复用相邻 Python 03 的工具与评分器，不复制或更改评分标准。"""

from pathlib import Path
import sys


SCORING_DIR = Path(__file__).resolve().parent.parent / "03-automatic-scoring"
if not SCORING_DIR.is_dir():
    raise RuntimeError("请保留相邻的 Python 03-automatic-scoring 小节，运行方式见 README.md。")
# 上一节是独立的平铺 CLI。本节使用 traced_* 文件名，避免同名模块冲突。
# 路径追加在末尾，不覆盖本节 main.py 等入口；全部依赖都留在 Python 目录。
if str(SCORING_DIR) not in sys.path:
    sys.path.append(str(SCORING_DIR))

from agent_service import execute_order_tool
from evaluation_service import EvaluationService, RUBRIC_VERSION
from model_service import ModelService
from sample import load_case, parse_json


__all__ = ["execute_order_tool", "EvaluationService", "RUBRIC_VERSION", "ModelService", "load_case", "parse_json"]
