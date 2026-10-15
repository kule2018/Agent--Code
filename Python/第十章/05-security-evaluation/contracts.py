"""JSON、时间与比较的小型兼容函数，避免 Python 隐式类型转换改变安全检查。"""

from datetime import datetime, timezone
import json
import math


# 对齐 JavaScript trim，包含 BOM；只用于原例明确调用 trim 的配置和最终回答。
TEXT_WHITESPACE = "\u0009\u000b\u000c\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000\ufeff\u000a\u000d\u2028\u2029"


def json_text(value, *, indent=None):
    # 合成商品标记用于泄露检查，必须保留中文，不能变成 \uXXXX 后漏掉字面标记。
    return json.dumps(value, ensure_ascii=False, indent=indent,
                      separators=(",", ":") if indent is None else None, allow_nan=False)


def parse_json(value):
    def invalid_constant(constant):
        raise ValueError(f"无效 JSON 常量：{constant}")

    return json.loads(value, parse_constant=invalid_constant)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value):
    """解析本例保存的 ISO 时间；无效时间返回 NaN，比较过期时间时不会被放行。"""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp() * 1000
    except (AttributeError, TypeError, ValueError, OverflowError):
        return float("nan")


def iso_time(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def deep_equal(left, right):
    """对齐 JSON 数据的严格深比较：金额 1 不等于 true，数字 3500 与 3500.0 等价。"""
    numeric = (int, float)
    if type(left) in numeric and type(right) in numeric:
        if left == 0 and right == 0:
            return math.copysign(1, left) == math.copysign(1, right)
        return left == right or (isinstance(left, float) and isinstance(right, float)
                                 and math.isnan(left) and math.isnan(right))
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(deep_equal(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(deep_equal(a, b) for a, b in zip(left, right))
    return left == right


def js_truthy(value):
    # JavaScript 的空对象/空数组为真，不能在订单结果校验中被 Python 的 bool({}) 跳过。
    if value is None or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    return value != "" if isinstance(value, str) else True
