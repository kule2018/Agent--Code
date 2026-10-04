"""持久化项目和事件使用 JSON 字典，字段名保持与工作台 API 一致。"""

from datetime import datetime, timezone
from typing import Any

Project = dict[str, Any]
ProjectEvent = dict[str, Any]
STOPPED = {"cancelled", "failed", "ready"}


def now_iso() -> str:
    # 与 JavaScript Date.toISOString 一致，保留毫秒并使用 UTC 的 Z 后缀。
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
