"""可选真实 Docker 检查：固定模型决策，不调用 ASR、TTS 或 DeepSeek。"""

import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from analysis import analyze  # noqa: E402
from dataset import prepare_dataset  # noqa: E402


def main():
    # 只在临时目录导入样本，真实执行仍经 Python 05 的受限 Docker 容器。
    with tempfile.TemporaryDirectory(prefix="voice-sandbox-check-") as root:
        dataset = prepare_dataset(Path(root))
        provider = SimpleNamespace(
            mode="replay",
            decide=lambda *_: {"action": "query",
                               "sql": "SELECT region, SUM(paid_amount) AS sales_amount FROM sales WHERE sold_at >= DATE '2026-09-01' AND sold_at < DATE '2026-10-01' GROUP BY region ORDER BY sales_amount DESC",
                               "metric": "未扣退款销售额", "scope": "2026 年 9 月已导入记录"},
            explain=lambda *_: "Replay：查询已经完成，请核对真实数据库结果；不代表完整月份业绩。",
        )
        result = analyze("各区域的销售额？", dataset=dataset, provider=provider)
        if result["status"] != "answered":
            raise RuntimeError(result["answer"])
        assert result["rows"] == [{"region": "华东", "sales_amount": "1599.00"},
                                  {"region": "华南", "sales_amount": "798.00"}], result["rows"]
        print("真实 Docker 检查通过：华东 1599.00、华南 798.00；没有调用付费模型。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Docker 检查失败：{error}", file=sys.stderr)
        sys.exit(1)
