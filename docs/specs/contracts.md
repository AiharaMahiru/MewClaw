# dsh-lark-contracts SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-contracts` |
| 位置 | `packages/lark/contracts` |
| 角色 | Contracts（跨包共享稳定类型，无运行时依赖） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-2, ADR-4, ADR-5, ADR-6 |
| 依赖能力 | `dsh-brand`、`dsh-session`（类型复用） |
| 提供能力 | `SessionEventMap` 声明合并、`Scope`、运行/控制契约、错误分类学 |

## 1 目的与边界

为飞书平台的跨包契约提供**唯一类型家园**：Scope、身份 ID、运行与控制契约、类型化 session 事件、错误分类学。任何包不得自行再定义这些类型。

非目标：不含任何运行时逻辑、不含 Feishu API 载荷模型（归 `dsh-lark`）、不含业务实现。

## 2 服务契约

无（纯类型包）。

## 3 配置契约

无（纯类型包）。

## 4 事件契约

### 4.1 身份与 Scope

```ts
// 全部经 dsh-brand 品牌化；parse* 校验：非空、≤ 256 字符、不含控制字符。
type TenantId = Branded<string, 'tenant'>
type BotId = Branded<string, 'bot'>
type DeploymentId = Branded<string, 'deployment'>
type UserId = Branded<string, 'lark-user'>      // Feishu open_id
type ConversationId = Branded<string, 'conversation'>
type RunId = Branded<string, 'run'>
type MessageId = Branded<string, 'lark-message'>  // 飞书消息 id
type ChatId = Branded<string, 'lark-chat'>        // 飞书群 id
type InteractionId = Branded<string, 'interaction'>
type ArtifactId = Branded<string, 'artifact'>
type ImageKey = Branded<string, 'lark-image'>     // 飞书图片资源 key
type JobId = Branded<string, 'job'>               // UUID（严格八位组校验）

interface Scope {
  tenantId: TenantId
  botId: BotId
  deploymentId: DeploymentId
  userId: UserId
  conversationId: ConversationId
}
```

`Scope` 是**不可信输入**：一切跨进程进入的 Scope 都要过 `parseScope(unknown): Scope | ScopeError`（wire 边界校验）。进程内比较用结构化相等。

### 4.2 SessionEventMap 声明合并

在 `@deepseek-ai/dsh-session` 的 `SessionEventMap` 上声明合并以下成员（`@mode` + payload `@param` JSDoc 齐全）：

| 事件 | `ignorable` | 语义 | 关键 payload 字段 |
| --- | --- | --- | --- |
| `lark/message/in` | 否（模型输入载体） | 一条经授权的用户消息进入会话 | `scope`, `messageId`, `text` |
| `lark/artifact/created` | 否（交付物可重建） | 会话产出用户可交付文件 | `scope`, `artifactId`, `name`, `digest`, `bytes` |
| `lark/knowledge/citations` | 否（当前运行时不支持 ignorable） | 知识检索引用随回答展示 | `scope`, `citations[]` |
| `lark/approval/requested` | 否（当前运行时不支持 ignorable） | 卡片审批已发出 | `scope`, `interactionId`, `kind`, `question` |
| `lark/approval/resolved` | 否（当前运行时不支持 ignorable） | 卡片审批已得到答复/过期 | `scope`, `interactionId`, `outcome` |
| `lark/run/context` | 否（模型可见输入载体） | 附件、摄入与检索的有界上下文块 | `scope`, `blocks` |
| `lark/run/preset` | 否（模型可见输入载体） | 本次运行的模板身份和技能摘要 | `scope`, `preset`, `revision`, `version`, `skills` |
| `lark/memory/recalled` | 否（模型可见输入关联） | 本次运行的记忆召回计数 | `scope`, `count` |

规则：scoped 键一律来自事件自身的 `scope` 字段，payload 内不得重复携带（`@dshScopeScan unsupported` 不适用处不写）。**M1 实证调整（两处）**：(1) dsh-session 0.1.0-rc.6 的 `session.append()` 不暴露 `ignorable` 标记——lark/* 事件一律为必需事件，本包在 import 时把事件名注册进 `KNOWN_SESSION_EVENT_TYPES`（官方扩展机制，见 `packages/lark/contracts/src/runtime.ts`），否则 session-persistence 按"未知必需事件"拒绝装载（证据 docs/evidence/m1-e2e-vertical-slice.md）；(2) `lark/approval/requested` 额外携带问题呈现数据（id/question/options），网关据此渲染交互卡。

### 4.3 运行与控制契约（wire 类型）

DSH 0.1.5-rc.2：`RunStreamItem` 为同一完整运行信封下的 `{ event: SessionEvent } | { assistant: { turn: number; step: number; text: string } }`。assistant 行仅转发官方 `agent/assistant-stream` 的临时 text-delta，不伪造持久化 session 事件、seq 或模型输入；最终消息及其嵌入 stream 由官方 `assistant/message` / `assistant/attempt` 落盘。网关先验 Scope/runId，再校验非负安全整数 turn/step 和字符串 text；拒绝同时包含 event 与 assistant 的行。完成消息到达时以最终正文替换该 step 的临时正文，不能将部分流输出当作最终结果。断线不重放副作用；Worker/Gateway 必须配套升级。

```ts
interface RunRequest {           // 网关 → worker
  runId: RunId
  scope: Scope
  messageId: MessageId           // 触发消息 id（写入 lark/message/in 来源记录）
  prompt: string                 // 非空；正文文本
  profile?: 'quick' | 'standard' | 'long'
  sessionGeneration?: number     // /clear 递增的安全整数代次（0..1_000_000；缺省 0 = 初始会话）
  attachments?: RunAttachment[]  // M3 附件描述；size 为非负安全整数，wire 边界按 Scope + SHA-256 校验
}
interface SessionOverviewRequest {
  scope: Scope
  sessionGeneration: number     // 安全整数 0..1_000_000
}
interface SessionDirectoryRequest {
  scope: Scope
  sessionGeneration: number     // generation 变化不继承上一代绑定
}
interface SessionClaimRequest extends SessionDirectoryRequest {
  code: string                  // 短期一次性 claim code；只在 Worker 内存校验
}
interface SessionUseRequest extends SessionDirectoryRequest {
  sessionId: string             // 资源标识；Worker 必须复核它属于当前 Scope 的 claim 集合
}
interface SessionDirectoryEntry {
  sessionId: string
  selected: boolean
  claimedAt: string
  lastUsedAt: string
}
type SessionDirectoryCurrent =
  | { mode: 'deterministic'; sessionId: string }
  | { mode: 'shared'; sessionId: string }
interface SessionDirectoryList { sessions: SessionDirectoryEntry[] }
interface ArtifactReadRequest { // Gateway → Worker；没有任意路径字段
  scope: Scope
  artifactId: ArtifactId
  name: string                 // 单个安全 basename，非隐藏且不是 uploads
  digest: string               // 64 位小写 SHA-256
  bytes: number                // 1..30 MiB 的安全整数
}
type SessionOverview = { exists: false } | {
  exists: true
  todos: TodoItem[]
  usage: SessionOverviewUsage
  lastActivityAt?: string
}
interface CronControlCommand {   // 网关 → worker（M2 起，此处先定型）
  kind: 'list' | 'get' | 'update' | 'start' | 'stop' | 'delete'
  scope: Scope                   // 必需的完整状态与授权边界
  jobId?: JobId                  // 必须通过 parseJobId 校验（UUID）
  payload?: unknown              // 每 kind 单独 schema 校验
}
```

### 4.4 错误分类学（typed errors，全仓共享）

| 错误 | 类别 | 触发 |
| --- | --- | --- |
| `UNAUTHORIZED_SCOPE` | 用户可见失败 | Scope 不在允许列表 / 不属于该部署 |
| `INVALID_REQUEST` | 调用方 bug | wire 校验失败（含非法 UUID、空 prompt） |
| `SESSION_CREATE_FAILED` | 环境故障 | 会话/预检创建失败（fail closed） |
| `SESSION_CLAIM_INVALID` | 用户可见失败 | claim code 未知、过期或已消费 |
| `SESSION_NOT_AVAILABLE` | 用户可见失败 | session 未授权、已删除或 header/cwd 不可用 |
| `SESSION_DIRECTORY_FAILED` | 环境故障 | 授权目录损坏或原子持久化失败 |
| `RUN_TIMEOUT` | 用户可见失败 | 无进展窗口 / 硬上限到期 |
| `QUEUE_FULL` | 用户可见失败 | per-scope 队列超深 / 全局并发满 |
| `CANCELLED` | 用户可见失败 | 用户主动取消 |
| `EMPTY_RESPONSE` | 用户可见失败 | 运行结束无可见文本/产物 |
| `RUNTIME_ERROR` | 环境故障 | 会话运行期异常（脱敏，不暴露提供方细节） |
| `BILLING_QUOTA_EXCEEDED` | 用户可见失败 | 当前用户自然月模型额度已用尽 |

跨进程传输只用**错误码 + 脱敏信息**，不传堆栈。

## 5 模型可见面

无（类型包；事件承载由各插件负责，见各 SPEC）。

## 6 行为契约

- 所有 ID 构造/解析函数是纯函数，非法输入返回 typed error，不抛裸异常；
- `parseScope` / `parseJobId` / `parseRunId` 必须抵御：超长、空串、控制字符、非字符串、原型污染键；
- `ArtifactReadRequest` 是闭合 wire 契约：未知字段、目录名、路径分隔符、非规范 SHA-256 与非法大小在 Worker HTTP 边界拒绝；
- 会话目录 wire DTO 是闭合契约：sessionId 只用于定位，`claim/use/list/run` 始终以完整 Scope + generation 重新授权；
- 版本语义：类型变更须经评审并同步更新消费方 SPEC（wire 契约无默认值宽容——新增必需字段前先版本协商）。

## 7 安全与信任

- Scope 与一切 ID 来自跨进程/网络输入时一律视为不可信，先 parse 后使用；
- artifact read 的名称、摘要和字节数同样不可信；它们只作为 Worker 重验与定位同一顶层常规文件的证据，永不构造任意路径；
- 事件 payload 中禁止出现：密钥、凭证引用之外的环境值、隐藏推理内容、原始工具输出全文（引用 digest 替代）。

## 8 测试契约

- `unit`：全部 parse 函数的拒绝用例（超长/空/控制字符/非字符串/原型键）；
- `unit`：Scope 结构化相等与品牌化不可混用（编译期 + 运行时）；
- `security`：ArtifactReadRequest 解析拒绝错误 Scope、非法品牌 ID、路径逃逸、异常摘要和不安全字节数；
- `security`：会话目录请求拒绝未知字段、错 Scope/generation、非法 code 和任意未 claim sessionId；
- `unit`：包入口将全部声明的 `lark/*` 事件注册到 dsh-session 已知事件集；
- `snapshot`：`lark/message/in` 与 `lark/artifact/created` 的落盘→重放一致（M1 快照）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `packages/contracts/src/scope-contracts.ts` | 重写（品牌化 ID + parse 校验） |
| `packages/contracts/src/contracts.ts` | 拆分（运行契约保留；`UiEvent` 联盟删除） |
| `packages/contracts/src/cron-control-contract.ts` | 复用（UUID 校验语义保留） |
| `packages/contracts/src/interaction-contracts.ts` | 重写（并入 lark/approval/* 事件） |
| `packages/contracts/src/runtime-profile-contracts.ts` | 复用（profile 档位） |
| `packages/contracts/src/todo-contracts.ts` | **删除**（TODO 由 dsh tool-todo 取代） |
| `packages/contracts/src/admin-contracts.ts` | 删除（M3 由 dsh-lark-admin 自有类型） |

行为变化：`UiEvent` 联盟删除；`approval.requested` 等改由 session 事件承载（ADR-4）。

## 10 开放问题

1. ~~`RunId` 与 DSH 会话内 run 标识的关系~~ **已解决（M1）**：独立品牌化 `RunId` + 运行信封（`RunStreamItem { event, envelope: { runId, scope } }`，实现于 `packages/lark/contracts/src/run.ts`）；worker 内 runId 与 session 事件的关联由 dsh-lark-run 维护（envelope 每行携带，不写入事件 payload）。DSH 会话内的 turn/step 标识原样透传，不与 RunId 混淆。
2. `lark/message/in` 是否拆 `text` 与 `attachments`（M3）两个事件以保持 M1 格式稳定？（阻塞 M3；倾向拆）
