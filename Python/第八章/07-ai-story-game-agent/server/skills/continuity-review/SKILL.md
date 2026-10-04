---
name: continuity-review
description: 检查世界规则、人物目标和剧情内容是否发生明确冲突。
---

# 剧情一致性审核

只报告有原文证据的冲突。对于同一原因产生的多句描述，合并成一条问题。
每条问题给出当前场景 filePath、原文中的 quote、违反的 rule、reason 和不破坏其他设定的 suggestion。
引用必须来自场景 content；不要根据猜测补充世界观没有写出的设备能力。
若未发现明确冲突，返回 approved 和空 issues。只写任务指定的 review JSON 文件。
