"""工具结果和证据集校验。"""


def validate_observation(action, observation):
    """校验单次工具调用返回的 Observation 是否真正可用。

    该校验不仅判断工具是否调用成功，还会检查：
    - Observation 结构是否完整
    - records 字段是否存在且类型正确
    - records 中是否包含可作为证据的数据
    """

    # Observation 不存在、工具执行失败或缺少 data 时，
    # 说明工具没有返回符合约定的完整结果
    if not observation or observation.get("ok") is not True or not observation.get("data"):
        return invalid(
            "invalid_result",
            "MALFORMED_RESULT",
            f"工具 {action['toolName']} 没有返回完整 Observation。",
        )

    records = observation["data"].get("records")

    # records 应当是数组；字段缺失或类型错误都属于结果结构异常
    if not isinstance(records, list):
        return invalid(
            "invalid_result",
            "MISSING_RECORDS",
            f"工具 {action['toolName']} 的 records 字段缺失。",
        )

    # 工具调用虽然成功，但空数组不能作为完成计划步骤的有效证据
    if len(records) == 0:
        return invalid(
            "no_evidence",
            "EMPTY_RESULT",
            "工具调用成功，但没有返回可用证据。",
        )

    # Observation 结构完整，并且至少包含一条可用记录
    return {"ok": True}


def validate_evidence_set(observations):
    """交叉校验已经通过单条校验的多份证据。"""

    log_evidence = next(
        (
            item
            for item in observations
            if item["source"] in ["primary_logs", "backup_logs"]
        ),
        None,
    )
    inventory_evidence = next(
        (item for item in observations if item["source"] == "instance_inventory"),
        None,
    )

    if not log_evidence or not inventory_evidence:
        return {"ok": True}

    # 如果日志记录的运行版本与实例清单返回的版本不一致，则说明多份证据发生冲突
    log_version = log_evidence["data"].get("runtimeVersion")
    inventory_version = inventory_evidence["data"].get("activeVersion")

    if log_version and inventory_version and log_version != inventory_version:
        return invalid(
            "evidence_conflict",
            "RUNTIME_VERSION_CONFLICT",
            f"日志记录的运行版本是 {log_version}，实例清单返回的版本是 {inventory_version}。",
            {
                "evidenceKeys": [
                    log_evidence["evidenceKey"],
                    inventory_evidence["evidenceKey"],
                ]
            },
        )

    return {"ok": True}


def classify_tool_error(error):
    if getattr(error, "code", None) == "UPSTREAM_TIMEOUT":
        return {
            "kind": "transient_error",
            "code": error.code,
            "message": str(error),
            "details": getattr(error, "details", {}) or {},
        }

    return {
        "kind": "unexpected_error",
        "code": getattr(error, "code", None) or "UNEXPECTED_ERROR",
        "message": str(error),
        "details": getattr(error, "details", {}) or {},
    }


def invalid(kind, code, message, details=None):
    return {
        "ok": False,
        "failure": {
            "kind": kind,
            "code": code,
            "message": message,
            "details": details or {},
        },
    }
