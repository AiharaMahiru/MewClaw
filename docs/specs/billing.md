# dsh-lark-billing SPEC（模型计费与额度能力缝）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-billing` |
| 位置 | `packages/lark/billing/` |
| 角色 | Definition + Provider（Worker/Admin 共用） |
| 里程碑 | M7 |
| 状态 | implementing |
| 依赖能力 | `credentials`、`dsh-lark-contracts`、PostgreSQL |
| 提供能力 | `ctx.billing` |

## 1 目的与边界

记录模型调用的 token 用量、按模型价格结算、按用户限制自然月额度，并为管理员提供聚合分析。计费数据只属于现有多用户 Scope；本能力不改变认证、工作区、沙箱或权限隔离，也不从浏览器路径推断用户身份。

额度策略按 `tenant/bot/deployment/user` 管理，实际账本仍保留完整 `conversationId`，因此不同会话的用量可审计且不会跨用户聚合。周期为 UTC 自然月，管理员 API 与配置使用 USD；数据库内部以 1 USD = 1,000,000 个微美元整数保存，旧 `micro-credit` 列名保留以兼容既有账本。

## 2 服务契约

```ts
interface BillingService {
  assertCanStart(scope: Scope): Promise<void>
  recordUsage(input: UsageInput): Promise<UsageCharge> // 幂等
  quota(scope: Scope): Promise<QuotaSnapshot>
  setQuota(scope: Scope, monthlyLimitMicroCredits: number): Promise<QuotaSnapshot> // Provider 内部精确单位
  listPrices(): Promise<ModelPrice[]>
  setPrice(price: ModelPrice): Promise<ModelPrice>
  aggregate(filter: UsageAggregateFilter): Promise<UsageAggregate[]>
}
```

`recordUsage` 使用 `(runId, turn, step, provider, model)` 唯一键；重复投递只返回既有账本行，不重复扣费。账本行保存当时使用的价格与计算结果，价格修改不回写历史。

## 3 配置契约

```ts
interface Config {
  databaseUrlEnv: string
  namespace?: { tenantId: string; botId: string; deploymentId: string }
  defaultMonthlyLimitUsd?: number
  /** 旧版兼容字段；新部署使用 defaultMonthlyLimitUsd。 */
  defaultMonthlyLimitMicroCredits?: number
  defaultPrice: {
    inputMicroCreditsPerMillion: number
    outputMicroCreditsPerMillion: number
    cacheReadMicroCreditsPerMillion: number
    cacheWriteMicroCreditsPerMillion: number
    reasoningMicroCreditsPerMillion: number
  }
}
```

`namespace` 是 Worker/Admin 必须一致的专用计费账本域。它只投影计费 Scope 的
`tenant/bot/deployment`，不修改 Session、工作区、工具或权限使用的原始 Scope；生产固定到现有
Lark Admin 身份域，使 Web UUID 用量与飞书历史账本可由同一 Admin/账户接口读取。

连接串只接受凭证引用，缺失时 fail loud。价格、额度的用户输入必须是非负、最多 6 位小数的 USD；仅缺省字段使用默认值。内部微美元费用计算为 `ceil(tokens * usdPerMillion * 1_000_000 / 1_000_000)`，避免浮点金额误差。DeepSeek 官方模型默认采用官网 Models & Pricing 页面记录的 off-peak 价格；`reasoningTokens` 已包含在 completion/output token 中，不重复收费。

## 4 事件与运行接入

- Worker 在运行进入 agent 前调用 `ctx.billing.assertCanStart(request.scope)`；已耗尽额度拒绝新运行。
- Worker 监听 session 的 `request/context` 保存当前 provider/model。
- 每个带 `usage` 的 `assistant/message` 结算一次；结算失败不伪造用量，错误进入 Worker 日志并使本次运行返回计费故障。
- `assistant/message` 及其 usage 已在 session log 中持久化，账本可由 Scope 与运行键重放核对。
- DSH Web 原生 Agent 复用 Auth Edge 写入的 `larkScopeIndex`：`agent/pre-step` 在模型调用前检查额度，
  根级 `session/event` Consumer 将带 usage 的 `assistant/message` 按
  `(sessionId, turn, step, provider, model)` 幂等结算。飞书 `executeRun()` 活跃时必须排除该
  Consumer，避免同一条 usage 双路径扣费。
- Worker 恢复旧 Web 会话时，构造种子中的历史事件不会重新发布到 `session/event`；计费
  Consumer 必须从 `Session.requestContext()` 重建最近的 provider/model 路由，并保留 usage
  到达时的惰性恢复兜底。不得重放历史 usage，也不得因进程重启把旧会话永久标记为结算失败。
- Web session 的上一条异步结算必须在下一次 `agent/pre-step` 前完成；结算失败要阻断后续
  模型请求并保留可诊断日志，不能静默形成“有 token、无账本”的状态。

## 5 管理 API

均挂在现有 admin Bearer 守卫之后，admin Scope 仅能访问同一 `tenant/bot/deployment`：

```
GET  /api/admin/billing/summary?userId=&provider=&model=&from=&to=
GET  /api/admin/billing/quota?userId=
PUT  /api/admin/billing/quota       { userId, monthlyLimitUsd }
GET  /api/admin/billing/prices
PUT  /api/admin/billing/prices      { provider, model, ...rates }
```

`GET /quota` 返回 `monthlyLimitUsd/usedUsd/remainingUsd`；价格接口返回 `*UsdPerMillion`；聚合结果返回 `totalUsd`。非法 ID、日期、额度或价格返回 `400 INVALID_REQUEST`；非 admin 请求仍返回 `401`。内置官方目录来源：[DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) 与 [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)；OpenAI 使用标准档每百万 token 价格，输出价已包含 reasoning token。

## 6 安全与失败模式

- 所有账本 SQL 都带 Scope 谓词；`runId` 或账本 ID 不是授权证据。
- admin 查询只接受配置 admin 的 tenant/bot/deployment，不能通过参数切换租户。
- PG 不可用时 Provider 装载失败；运行中的结算异常不吞掉，避免静默丢账。
- 额度耗尽使用 `BILLING_QUOTA_EXCEEDED` 用户可见错误；历史超额账本保留，便于审计。

## 7 测试契约

- 内存 Provider：价格回退、自然月、额度、幂等、Scope 隔离和聚合。
- PG Store：参数化 SQL、唯一键冲突返回既有行、事务回滚与迁移版本。
- Worker：额度耗尽不创建 agent；`request/context` + `assistant/message.usage` 产生一条账本行。
- Web Worker：认证 Scope 命中后先做额度预检；成功、中断且携带 usage 的消息均入账；
  重启恢复的旧会话可从持久化 request context 重建路由且不重放历史 usage；
  未绑定 Web Scope 的 session 不得归属或写入任何用户账本；飞书活跃运行不重复结算。
- Admin：Bearer 守卫、同 admin Scope 的用户过滤、非法输入拒绝。
