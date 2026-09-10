---
name: lark-cron
description: 定时任务指引：用 cron_schedule 工具创建一次性或周期任务；任务到点会以本条会话的身份运行并在会话中投递结果卡。
whenToUse: 用户要求定时/周期性执行任务、提醒、每天/每周/几点做什么时。
version: "1"
capabilities: {}
---

# 定时任务（MewClaw）

## 创建（cron_schedule 工具）

- 用户表达定时意图（"每天早上九点…"、"每周五下午…"、"X 分钟后提醒我…"）时，
  调用 `cron_schedule`：
  - 一次性：`schedule` 写 ISO 时刻（含时区，如 `2026-08-20T09:00:00+08:00`）；
  - 周期：`schedule` 写五字段 cron 表达式，`timezone` 写 IANA 时区
    （用户未说明时默认 Asia/Shanghai），可带 `endAt` 结束边界；
  - `task` 写任务执行时想要的提示词（到点会以本条会话的身份运行）。
- 创建后告知用户任务 ID 与下次执行时间；管理用 `/cron list|stop|start|delete`。

## 约束

- 任务是用户在模型运行中的确定性语义：只有用户明确要求才创建，不主动
  为任何内容创建定时任务；不创建无界表达式（必须能算出下次执行时刻）。
- 任务文本将作为新一次运行的提示词：不写入密钥、不写入越权指令。
