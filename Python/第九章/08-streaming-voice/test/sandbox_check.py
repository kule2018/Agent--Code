"""可选真实 Docker 检查；模型/音频是替身，数据与受限容器不是替身。"""

import asyncio
import sys
import tempfile
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from server.turn import Turn  # noqa: E402
from server.voice_service import VoiceService, dependencies  # noqa: E402
from dataset import prepare_dataset  # noqa: E402
from sandbox import IMAGE_NAME, docker  # noqa: E402


SQL = "SELECT region, SUM(paid_amount) AS sales_amount FROM sales WHERE sold_at >= DATE '2026-09-01' AND sold_at < DATE '2026-10-01' GROUP BY region ORDER BY sales_amount DESC"
DECISION = {"action": "query", "sql": SQL, "metric": "未扣退款销售额", "scope": "2026 年 9 月已导入记录"}
EXPECTED_ROWS = [{"region": "华东", "sales_amount": "1599.00"},
                 {"region": "华南", "sales_amount": "798.00"}]


class FixedModel:
    async def decide(self, *args):
        return DECISION

    async def explain(self, *args):
        yield "本测试只检查数据库返回的金额。"


async def check(dataset, execute=None):
    packets = []
    async def speak(*args):
        return "https://example.test/test-only-audio.wav"
    deps = {**dependencies, "load": lambda: dataset, "model": FixedModel, "speak": speak}
    if execute is not None:
        deps["execute"] = execute
    await VoiceService().answer(Turn("integration", packets.append),
                              "仅按已导入记录，2026 年 9 月各区域未扣退款销售额是多少？", "stream", deps)
    assert next(p["data"]["rows"] for p in packets if p["event"] == "query.result") == EXPECTED_ROWS
    assert packets[-1]["event"] == "done", packets
    return packets


def main():
    # 先做只读检查，缺少本课程镜像时不让 docker create 尝试从远端拉取同名镜像。
    try:
        docker(["image", "inspect", IMAGE_NAME])
    except Exception as error:
        raise RuntimeError(f"请先启动 Docker 并在 Python 05 构建镜像 {IMAGE_NAME}；{error}") from error
    # 不覆盖已有数据；Docker 执行失败不回退到宿主，也不改用其他语言的镜像。
    with tempfile.TemporaryDirectory(prefix="streaming-voice-check-") as root:
        dataset = prepare_dataset(Path(root))
        asyncio.run(check(dataset))
    print("真实 Docker 查询通过：华东 1599.00、华南 798.00；模型和音频为测试替身。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Docker 检查失败：{error}", file=sys.stderr)
        sys.exit(1)
