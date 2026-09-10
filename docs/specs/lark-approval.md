# dsh-lark-approval SPEC（飞书卡片审批 Provider）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-approval` |
| 位置 | `packages/lark/approval` |
| 角色 | Provider（dsh `userInteraction`/审批能力的飞书交互卡实现） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；worker 侧 provider 已落地，网关侧呈现归 dsh-lark-gateway） |
| 关联 ADR | ADR-7 |
| 依赖能力 | `ctx.userInteraction`（宿主能力）、`ctx.lark`、PG（M1 可内存待办 + M2 起 PG） |
| 提供能力 | 问卷/审批的卡片呈现、回调解答、超时与非码过期 |

## 1 目的与边界

模型侧 `ask_user_question` / 审批请求在飞书端的呈现：发送交互卡片问卷、消费 `card.action.trigger` 回调、把答案/拒绝送回 dsh 交互服务，并保证 at-least-once 投递与过期。

非目标：审批**策略**（哪些工具要审批——dsh 能力/工具声明负责）；网关命令式 `/interaction` 入口（lark-commands 转发到本包）。

## 2 服务契约

实现 dsh userInteraction provider 接口（精确面待 M0 确认，见 §10）：

```ts
interface LarkApprovalProvider {
  /** 呈现一次交互请求；返回 interactionId。 */
  present(scope: Scope, request: InteractionRequest): Promise<InteractionId>
  /** 回调解答（幂等；重复回调返回同一结果）。 */
  resolve(interactionId: InteractionId, payload: unknown): Promise<void>
  /** 过期/取消。 */
  expire(interactionId: InteractionId): Promise<void>
}
```

待办存储接口（PG provider，M2 起；M1 用内存实现 + 显式标记非持久）：

```ts
interface PendingStore {
  create(scope: Scope, request: InteractionRequest, ttlMs: number): Promise<PendingRecord>
  find(id: InteractionId): Promise<PendingRecord | null>   // 含 Scope 归属
  markResolved(id: InteractionId, outcome: ResolveOutcome): Promise<void>
}
```

## 3 配置契约

```ts
interface Config {
  /** 卡片默认 TTL（默认 30 分钟；1 秒..24 小时）。 */
  ttlMs?: number
  /** 单卡最大选项数（默认 4；1..20；超出转"自定义回答"）。 */
  maxOptions?: number
  /** 每 scope 未决待办上限（默认 5；1..100；超出拒绝新请求）。 */
  maxPendingPerScope?: number
}
```

当前 M1 Provider 只接受以上三个内存待办配置。`postgres` 待办存储必须在其 Provider、迁移和独立 SPEC 同时落地后才可加入配置面，不能以未消费字段预先暴露。数值默认仅在字段为 `undefined` 时生效；`0`、负数、小数、不安全整数或越界值在注册 Provider 前 fail loud。

## 4 事件契约

发布（session 事件，contracts 已声明）：`lark/approval/requested`（ignorable）、`lark/approval/resolved`（ignorable，outcome ∈ answered/expired/aborted）。
消费：`lark/card/action`（审批类回调）。

## 5 模型可见面

无直接工具（呈现面由 dsh `tool-ask-user` 触发；本包是被调用的 provider）。

## 6 行为契约

不变量：

- 回调解答**幂等**：同一 interactionId 重复回调返回首次结果（写库用 `ON CONFLICT` 或等效 CAS）；
- 解答必须核对回调主体（open_id）与待办记录的 `scope.userId` 一致；
- 超时未答 → `expired` 送达交互服务（模型收到超时语义），待办记录保留 TTL 用于幂等；
- 非码（卡片已失效）→ 不解答、记日志计数。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 用户不答 | TTL 后 `expired` | 自动 |
| 重复回调 | 幂等返回 | 自动 |
| 回调主体不匹配 | 拒绝 + 日志 | 无副作用 |
| 发送失败（限流等） | 退回交互服务（模型收到失败语义） | 重试有界 |
| 待办存储不可用 | fail closed：拒绝新请求 | 环境修复 |

## 7 安全与信任

- 回调载荷是不信任输入：interactionId 格式校验（UUID）+ 记录存在性 + 主体一致性三重检查；
- 交互请求文本按卡片转义规则输出；选项文本截断上限；
- 日志不记答案内容。

## 8 测试契约

- `unit`：幂等解答（并发重复回调）、主体不匹配拒绝、TTL 过期、超限拒绝；
- `unit`：M1 内存 store 与 M2 PG store 行为一致性（同一契约套件）；
- `e2e`：真实交互卡往返（M1 验收烟雾）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/pi-worker/src/interaction-store.ts` | 复用（PG 待办语义）→ PendingStore |
| `packages/pi-runtime` 的 questionnaire 工具 | **删除**（dsh tool-ask-user 取代） |
| `apps/lark-gateway/src/interaction-command.ts` / `conversation-interaction.ts` | 复用（`/interaction` 入口语义） |
| `packages/lark-adapter/src/interaction-card.ts` | 复用（载荷） |

行为变化：自研问卷工具删除；交互呈现统一走 dsh userInteraction 能力（ADR-7）。M1 实施记录：

1. **拓扑拆分**：`userQuestions.ask()` 发生在 worker（agent 工具调用），provider 必须注册在 worker；本包 = worker 侧 provider（待办 + 出卡事件 + 答案结算）。网关侧呈现（交互卡发送）与回调解答（card.action.trigger → worker 控制端点）归 dsh-lark-gateway。
2. **出卡走会话事件流**：`lark/approval/requested`（含问题呈现数据）随运行 NDJSON 流到网关渲染；答案经 lark-run 新增的 `POST /v1/interaction/resolve` 控制端点回到 worker（进程内 `lark/interaction/resolved` 事件，契约在 contracts）。
3. **Scope 载体**：`ctx.larkScope`（contracts 声明合并）由 dsh-lark-run 在 agent setup 注入；本包经 `request.agent.ctx.larkScope` 定位呈现目标。
4. `ignorable` 标记不可用（dsh-session 0.1.0-rc.6 append 不暴露），lark/* 事件一律必需——见 contracts SPEC。

## 10 开放问题

1. ~~dsh userInteraction provider 的精确接口与挂载方式~~ **已解决（M1 实证）**：`ctx.userQuestions.registerProvider({ ask(request) → Promise<AskUserQuestionAnswer> })`；`AskUserQuestionRequest { questions, agent?, signal? }`，答案按问题 id 结构回显；`UserQuestionError(message, code)` 是类型化错误。证据 docs/evidence/m0-dsh-api-surface.md 补充。
2. 审批流（工具审批，非问卷）在飞书端的形态：M1 只做问卷，工具审批 M2 评估。
