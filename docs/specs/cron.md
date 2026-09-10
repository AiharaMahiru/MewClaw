# dsh-lark-cron SPEC（跨会话 cron 能力缝）

| 元数据 | 值 |
| --- | --- |
| 包 | **Definition 在 `dsh-lark-contracts`/cron**（类型 + Context 合并 + validateSchedule，R-15 分离）+ `dsh-lark-cron`（PG Provider + 执行器 + 执行期调度计算）+ `dsh-tool-cron`（Consumer，只依赖契约） |
| 位置 | `packages/lark/cron`、`packages/lark/tool-cron` |
| 角色 | 能力缝（三角色齐全） |
| 里程碑 | M4 |
| 状态 | implementing |
| 关联 ADR | ADR-9 |
| 依赖能力 | `ctx.credentials`；执行侧复用 `dsh-lark-run` 的 per-scope 串行执行器 |
| 提供能力 | `ctx.cron` |

## 1 目的与边界

跨会话的持久定时任务：PG 存储与租约、执行历史、结果投递 outbox、跨会话管理查询。与 dsh 内建 `dsh-schedule`（会话内提醒）**并存不合并**——本能力的作用域是用户跨全部会话，生命周期独立于会话。

非目标：OS crontab；网关侧执行（执行只发生在 worker）；自然语言解析（Consumer 工具负责归一化，本能力只存已解析调度）。

## 2 服务契约

```ts
interface CronService {  // ctx.cron
  create(scope: Scope, schedule: ParsedSchedule, task: string): Promise<Job>
  update(scope: Scope, jobId: JobId, patch: JobPatch): Promise<Job>   // 同 SQL 内重算 nextRunAt 并清租约
  pause(scope: Scope, jobId: JobId): Promise<void>
  resume(scope: Scope, jobId: JobId): Promise<void>
  remove(scope: Scope, jobId: JobId): Promise<void>
  list(scope: Scope, filter: ListFilter): Promise<JobSummary[]>      // 跨会话、按用户（管理授权边界）
  detail(scope: Scope, jobId: JobId): Promise<JobDetail>
  /** worker 侧：SKIP LOCKED 领取到期任务（租约 + 心跳续期）。 */
  claimDue(now: number, limit: number): Promise<JobClaim[]>
  /** worker 侧：运行结束 → 执行历史 + 投递 outbox 行。 */
  complete(claim: JobClaim, outcome: RunOutcome): Promise<void>
  /** worker 侧：outbox 领取/投递确认（at-least-once）。 */
  claimOutbox(now: number, limit: number): Promise<OutboxClaim[]>
  ackOutbox(id: OutboxId): Promise<void>
}
```

所有权不变量：一切操作按 tenant/bot/deployment/user 过滤；`jobId` 永非所有权证据；conversationId 只是执行与投递范围，不是管理授权边界（继承 lark-claw cron 约束）。

## 3 配置契约

```ts
interface Config {  // Provider
  /** 数据库连接凭证引用。 */
  databaseUrlEnv: string
  /** 轮询间隔：1s..1h，默认 10s；定时器只唤醒扫描，状态在 PG。 */
  pollIntervalMs?: number
  /** 任务租约：3s..24h，默认 15min；心跳按租约的 1/3 续期。 */
  leaseMs?: number
  /** outbox 投递租约：1s..24h，默认 5min。 */
  outboxLeaseMs?: number
  /** 每轮领取上限：1..100，默认 10。 */
  batchSize?: number
  /** 是否启动轮询；默认 true。 */
  enabled?: boolean
}
```

四个数值字段在 Provider 装载期必须是范围内的安全整数；**仅缺省
（`undefined`）才使用默认值**。零、负值、小数、非安全整数和超界值必须
fail loud，不能静默变成默认轮询、租约或 SQL `LIMIT`。

## 4 事件契约

发布：`lark/cron/delivered`（ignorable 展示事件；M2 定稿）。
消费：`lark/run/lifecycle`（运行结果回写执行历史——由 lark-run 发布）。

## 5 模型可见面

工具 `cron_schedule`（Consumer）：

- 参数：`{ schedule: string（ISO 时刻或五字段 cron）, timezone: string, task: string, endAt?: string }`——归一化在工具内完成（间隔秒数 → 等价 cron 表达式；IANA 时区校验）；
- Scope 来自运行信封，模型参数不可提供 tenant/user/visibility；
- 返回：创建的 Job 摘要（不含内部租约字段）。

## 6 行为契约

不变量：

- 到期任务经 `FOR UPDATE SKIP LOCKED` 领取；同一任务同一时刻至多一个执行者；
- 到期任务进入**同 scope 串行执行器**（与聊天运行共享序列化——ADR-9）；
- 投递 at-least-once：网关发送成功后才 ack；重复投递由网关幂等消化；
- 调度更新在同一 SQL 内重算 `nextRunAt` 并清旧租约（防窗口竞态）；
- 复发边界用显式 `endAt`（含端点），不搞无界表达式 + 内存停表。
- Runner 在运行结束、异常或租约丢失时必须取消尚未触发的心跳等待；不得留下阻止 Worker 进程退出的延迟计时器。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 租约持有者崩溃 | 租约超时被回收，任务重领 | 自动（幂等任务前提） |
| 运行无可见输出 | 按 EMPTY_RESPONSE 记历史、投递失败卡 | 用户修复任务 |
| outbox 投递失败 | 保留行待下轮重试 | 自动 |
| 时区/表达式非法 | 归一化拒绝 + 用户可见错误 | 用户修正 |
| PG 不可用 | 扫描静默一轮（计数日志） | 恢复后自动继续 |

## 7 安全与信任

- 控制端点命令白名单 + UUID 校验（contracts）；每次变更按 Scope 复核所有权；
- 任务文本进入模型运行前按提示注入规则处理（不可信证据）；
- 日志只记 jobId/结果码。

## 8 测试契约

- `security`：跨 scope 拒绝（用户 A 管理 B 的任务被拒）；jobId 冒用被拒；
- `unit`：SKIP LOCKED 领取、租约回收、同 scope 串行、send-before-ack、endAt 边界、同 SQL 重算；
- `unit`：运行快速结束或抛错后没有遗留的心跳计时器；租约失效时不写执行历史；
- `unit`：表达式归一化（180s → */3）、IANA 时区校验、非法输入拒绝；
- `e2e`：创建→到期→执行→投递卡全链路（M2 验收）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/cron/src/postgres-cron-store.ts` / `postgres-cron-row.ts` | 复用（Provider 存储层） |
| `skills/cron/src/postgres-cron-control-store.ts` | 复用（控制面存储） |
| `skills/cron/src/schedule.ts` / `types.ts` | 复用（调度解析/类型） |
| `skills/cron/migrations/*.sql` | 平移 |
| `skills/cron` 的 SKILL/CLI 部分 | 技能 `skills/lark-cron`（自然语言归一路径） |
| `apps/pi-worker` 的 CronRunner/CronService 组装 | 删除（组合进 cordis.yml 行） |

## 10 开放问题

1. `JobClaim` 执行与 lark-run 队列的关系 → **已解决（M4）**：事件驱动——dsh-lark-cron 经 `lark/run/submit` 进程事件提交合成 RunRequest，lark-run 接住走同一 per-scope 串行队列（ADR-9）；输出经 `lark/run/stream` 镜像捕获、结局经 `lark/run/lifecycle` 回写；两事件声明迁至 contracts/context（避免 run↔cron 包循环引用）；
2. （M4 新增）投递通道 → **已解决（M4）**：worker 写 outbox 行（cron_runs），网关 CronDeliveryPoller 经 `/v1/cron-deliveries/claim|ack` 端点认领/确认（send-before-ack，租约过期重领）；
3. （M4 新增）管理命令载体 → **已解决（M4）**：网关 `/cron list|stop|start|delete` 确定性命令 → `/v1/cron-control` 端点（命令白名单 + jobId UUID 校验 + Scope 复核）；模型面 `cron_schedule` 工具负责创建。
