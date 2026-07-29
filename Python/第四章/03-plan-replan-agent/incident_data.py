"""当前案例使用的本地故障数据。

alertContext 是任务开始时收到的未验证告警，
其他字段只有执行对应工具以后才会返回给 Agent。
"""

INCIDENT = {
    "serviceName": "payment-service",
    "alertContext": {
        "startedAt": "2026-07-28T15:10:00+08:00",
        "summary": "支付失败率突然升高。外围告警中出现过 DB_POOL_ACQUIRE_TIMEOUT，值班同学怀疑数据库连接池异常，但还没有核验。",
    },
    "metrics": {
        "window": "2026-07-28 15:00:00 - 15:20:00",
        "firstAnomalyAt": "2026-07-28T15:10:06+08:00",
        "http5xxRate": {
            "baseline": 0.4,
            "current": 31.8,
        },
        "p95LatencyMs": {
            "baseline": 180,
            "current": 2140,
        },
        "cpuUsagePercent": 43,
        "memoryUsagePercent": 58,
        "databasePoolUsagePercent": 46,
        "summary": "5xx 和响应延迟在 15:10 同时升高，但 CPU、内存和数据库连接池均处于正常范围。当前指标不支持连接池耗尽假设。",
    },
    "databasePool": {
        "activeConnections": 46,
        "maxConnections": 100,
        "waitingRequests": 0,
        "acquireLatencyP95Ms": 12,
        "summary": "数据库连接池状态正常，没有连接耗尽或请求排队迹象。",
    },
    "logs": {
        "window": "2026-07-28 15:08:00 - 15:18:00",
        "totalErrorCount": 731,
        "topError": {
            "code": "PAYMENT_CURRENCY_UNDEFINED",
            "message": "TypeError: Cannot read properties of undefined (reading 'currency')",
            "firstSeenAt": "2026-07-28T15:10:08+08:00",
            "count": 689,
            "version": "v2.4.1",
        },
        "summary": "主要错误来自 currency 字段读取失败，首次出现时间为 15:10:08，错误实例均运行 v2.4.1。",
    },
    "deployments": {
        "items": [
            {
                "version": "v2.4.1",
                "completedAt": "2026-07-28T15:09:42+08:00",
                "status": "completed",
                "changes": ["重构支付请求中的币种归一化逻辑"],
            },
            {
                "version": "v2.4.0",
                "completedAt": "2026-07-25T10:35:00+08:00",
                "status": "completed",
                "changes": ["更新支付渠道超时配置"],
            },
        ],
        "summary": "v2.4.1 在异常出现前约 24 秒完成发布，并修改了发生报错的币种归一化逻辑。",
    },
}
