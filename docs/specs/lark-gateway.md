# dsh-lark-gateway SPEC（网关宿主面核心）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-gateway` |
| 位置 | `packages/lark/gateway` |
| 角色 | Plugin（入口、身份、会话协调；宿主面） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-3, ADR-4, ADR-6, ADR-7 |
| 依赖能力 | `ctx.lark`、`lark/message/*`、`lark/bot/menu` 事件、`dsh-lark-run-client`、`dsh-lark-card`、`dsh-lark-approval` |
| 提供能力 | 消息/机器人菜单→会话协调；网关命令入口（与 lark-commands 协作） |

## 1 目的与边界

飞书消息、机器人菜单与卡片回调的唯一**授权与协调**面：allowlist 授权、事件去重、Scope 引导、会话协调（把消息交给 worker 运行、把运行事件交给卡片渲染）、附件 staging（M3）。

非目标：任何工具执行（硬边界）；卡片渲染细节（lark-card）；审批 UI 细节（lark-approval）；命令解析细节（lark-commands 只注册，解析归本包入口路由）。

## 2 服务契约

无新服务（纯编排插件）。注册网关命令入口（`ctx.commands`），并消费 §4 事件。

## 3 配置契约

```ts
interface Config {
  /** 授权的用户 Open ID 列表；非法 ID 在装载期拒绝。 */
  authorizedOpenIds: string[]
  /** 允许的 chat id 列表；空 = 不限制。 */
  allowedChatIds: string[]
  /** Scope 身份；缺省分别为 lark/default/default。 */
  tenantId?: string
  botId?: string
  deploymentId?: string
  /** 去重窗口，默认 10 分钟，范围 1s..1h。 */
  dedupTtlMs?: number
  /** 去重缓存上限，默认 10 万，范围 1..10 万。 */
  dedupMaxEntries?: number
  /** 运行工具行折叠上限，默认 8，范围 1..20。 */
  maxToolLines?: number
  processingCardText: string
  failureCardTemplate: string
  unauthorizedCardText?: string
  /** 代次 JSON 根；默认 var/gateway，显式值必须非空。 */
  stateDir?: string
  /** 附件落盘根目录。 */
  uploadsRoot: string
  /** 网关附件落盘上限（默认 100 MiB，1 byte..100 MiB）。 */
  maxAttachmentBytes?: number
  /** 未认领附件暂存 TTL（默认 10 分钟，1ms..24h）。 */
  attachmentTtlMs?: number
  /** cron 投递轮询，默认 15s；0 显式禁用，其他值为 1s..1h。 */
  cronPollIntervalMs?: number
}
```

去重、轮询与附件预算均只在字段缺省时使用默认；不安全整数、小数、负值或超范围值在
任何事件监听器、定时器、状态文件和凭证动作之前 fail loud。worker URL 与 worker token
由 `dsh-lark-run-client` 的独立配置面持有，不属于 Gateway 插件。

## 4 事件契约

消费：

| 事件 | 处理 |
| --- | --- |
| `lark/message/received` | 授权 → 去重 → 命令分流（lark-commands）→ Scope 引导 → 提交运行（run-client） |
| `lark/message/recalled` | 仅记录（M1） |
| `lark/card/action` | allowlist 授权 → 校验 actionId/form 载荷 → 转交 approval 或 commands provider；命令 action 不得进入 worker run |
| `lark/bot/menu` | 用户授权 → eventKey 命令白名单 → eventId 去重 → 解析真实 P2P chatId/完整 Scope → 复用 commands provider；不得进入 worker run |
| run 事件流（run-client） | 驱动 lark-card 渲染与收尾（成功替换、分类失败或流中断失败）；图片 artifact 经 Worker read、`ctx.lark.uploadImage()` 和 `image` 消息交付 |

发布：`lark/message/in`（进入会话的用户消息，非 ignorable，由 worker 落盘）。

## 5 模型可见面

无（网关不挂任何工具——硬边界）。

## 6 行为契约

不变量：

- 未过授权的消息**不产生任何运行**；授权判定在去重之前（防放大）；
- 同一 platform messageId 只处理一次（窗口内幂等）；
- 平台 `event_id` 仅作为有界、无控制字符的去重键；缺失或非法时回退已校验的
  `messageId`，不得把不可信原值写入去重状态；
- 运行事件必须校验 `runId` + 完整 `Scope` 与已提交运行一致后才允许驱动卡片；
- 运行结束无可见文本/产物（EMPTY_RESPONSE）→ 替换处理卡为失败卡，绝不留 pending 卡。
- 运行流提前 EOF、心跳超时、连接中断或协议异常 → 按错误码替换处理卡为失败卡；缺失 `RunStreamDone` 绝不留 pending 卡，终态更新幂等。
- 图片 artifact 只调用 run-client 的受限 Worker reader；读取、上传或发送失败只追加简短交付失败提示，绝不把已经 `OK` 的 run 替换为失败卡。
- command 类型的卡片回调只消费 commands provider 中已注册且 Scope 绑定的一次性 action；
  未注册、过期、重复或错 Scope 回调只返回失败卡，绝不提交 `RunFlow`。
- 菜单事件只有 open_id，不含 chat_id；Gateway 可复用本进程已观察到的授权 P2P chat，或在
  `allowedChatIds` 为空时调用 `ctx.lark.sendMessageToUser()` 并采用平台返回的真实 chatId；
  不得把 open_id 当 chat_id，也不得在 chat allowlist 受限且无已知 P2P chat 时主动发送。
- 菜单 eventId 与消息 eventId 共用有界去重器；未知 eventKey 在任何发送、Scope 构造或命令副作用前拒绝。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 消息未授权 | 静默忽略（或礼貌性拒绝卡，可配置） | 无运行产生 |
| 重复事件 | 去重命中，忽略 | 自动 |
| 菜单用户/目标 chat 未授权或 eventKey 未知 | 静默拒绝，不发送、不执行命令 | 修正 allowlist 或菜单配置 |
| 菜单 P2P 解析失败 | 脱敏告警，不构造 Scope | 平台恢复后用户重试 |
| worker 不可达 | 失败卡（含重试说明） | worker 恢复后用户重发 |
| 事件流中断、心跳超时或提前 EOF | 处理卡替换为"中断"卡 | 手动重试 |
| 事件/响应 schema 不符 | 处理卡替换为协议错误卡 | 修复 worker 后重试 |
| 图片 artifact 读取、上传或发送失败 | 保留处理卡与 run 结果，追加简短交付失败提示 | 用户重新生成或重试 |
| cron 身份缺失（M2） | 单一存储候选恢复 → 应用 ID 兜底 | 自动 |

并发：同一 conversationId 的运行提交由 worker 侧 per-scope 队列串行；网关不自行加锁（避免双份真相）。

## 7 安全与信任

- `authorizedOpenIds` / `allowedChatIds` 来自 Config；回调里的 `open_id`、`user_id` 是**不可信输入**，只用于与服务端状态比对；
- 菜单 eventKey 只能经 commands provider 的显式映射解析；原值不得直接拼接为 slash 命令。
- 卡片回调值（actionId/interactionId/jobId）一律先 schema 校验再查找服务端记录；记录归属（完整 Scope）必须与回调主体一致；
- actionId 只是服务端状态引用，绝不是授权证据；任何 callback 都必须先通过 gateway allowlist。
- artifact 名称、摘要、字节数和 image MIME 不能作为 Gateway 文件访问依据；Gateway 不持有工作区路径，仅把事件元数据与完整 Scope 交给 Worker reader。
- Gateway 只路由两条闭合回调链：命令 `actionId` → commands provider，问卷表单 →
  `resolveInteraction`。未有 Consumer 的 handoff 与 session-delete 在解析边界拒绝。
- 不记录消息正文到日志。

## 8 测试契约

- `unit`：授权拒绝（陌生 open_id/chat）、去重幂等、EMPTY_RESPONSE 替换、流提前 EOF/中断/连接失败、重复终态幂等、事件 scope 不匹配拒绝；
- `unit`：命令分流（已知/未知/带参数命令）；
- `unit`：菜单授权、eventId 去重、旧 eventKey 映射、真实 P2P chatId Scope、受限 chat 与未知键 fail closed；
- `unit`：PNG artifact 调用 run-client reader、图片上传与 `kind: "image"` 消息；非图片仍追加 artifact 行；图片交付失败不改变 OK 终态；
- `e2e`：真实飞书多轮会话（M1 验收烟雾）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/conversation-handler.ts` | 重写（Pi 会话协调 → run-client 协调） |
| `apps/lark-gateway/src/scope-bootstrap.ts` | 复用（Scope 引导 + cron 身份恢复语义） |
| `apps/lark-gateway/src/gateway-message-store.ts` | 复用（去重/消息存储语义；附件暂存语义见 M3 记录 4） |
| `apps/lark-gateway/src/attachment-service.ts` | 平移为 GatewayAttachments（下载落盘 + 暂存认领，见 uploads.md SPEC） |
| `apps/lark-gateway/src/session-command.ts` / `handoff-command.ts` | 复用（M1 内 `/clear`、`/handoff` 语义） |
| `apps/lark-gateway/src/cron-*.ts` / `todo-*.ts` | M2 迁移（cron）；todo 管理命令降级/删除 |
| `apps/lark-gateway/src/main.ts` | 删除（组合进 apps/lark-gateway cordis.yml） |

行为变化：消息处理从"网关进程内长驻 handler 图"变为"事件驱动的插件职责链"；`/todo` 管理命令降级（DSH tool-todo 会话本地）。菜单事件（R-19 修订）：原“仅观察、不迁移”决定因实际部署已配置机器人菜单而撤销；新增 `ctx.lark.sendMessageToUser()` P2P 解析能力后，菜单经 Gateway 授权/去重并复用 lark-commands，不恢复旧网关的第二套命令执行器。lark-claw 的网关 PG 单例进程锁未迁移（R-21 终态：单实例部署由 infra/windows supervisor 唯一托管承担——supervisor 每服务单进程、崩溃退避重启，进程内无并发实例；跨机多实例部署超出当前部署模型，出现该需求时再引入分布式锁并立 SPEC）。M1 实施记录：

1. **审批呈现与解答归本包**（与 lark-approval 的拓扑拆分，见其 SPEC §9）：approval/requested 事件 → 问卷卡；card.action.trigger 问卷提交 → worker 控制端点。
2. **RunRequest 增 sessionGeneration**（contracts §4.3）：/clear 递增代次（stateDir JSON 原子持久化），worker 据此派生新 sessionId（旧会话保留）；恢复 JSON 只接受 contracts 统一定义的 `0..1_000_000` 安全整数。
3. 网关命令路由用 dsh-lark-commands 的自有命令表（dsh-commands 注册表是进程内 agent 语义，不适合网关侧路由——记录于 lark-commands SPEC §9）。
4. 菜单事件使用同一命令路由；首次 P2P 目标由 `ctx.lark.sendMessageToUser()` 的平台响应解析，后续可复用进程内观察到的授权 P2P chat。

M3 实施记录：

5. **附件落盘与暂存**（uploads.md SPEC）：消息资源经 `ctx.lark.downloadResource` 落 `.uploads/<scopeKey>/<uuid>-<sha><ext>`（流式 SHA-256 + 大小上限 + 可选 CDG 探测），按会话 TTL 暂存，下一次运行整体认领（`RunRequest.attachments` 随桥接提交）；默认每会话暂存至多 10 条（可由内部构造参数降至 1、升至 100）。所有字节/TTL/条目数值只在字段缺省时默认，显式非法值在构造时拒绝；lark-claw 的 PG 暂存表简化为进程内 TTL 暂存（行为变化，见 uploads SPEC §9）。
6. **图片 artifact 交付**：历史目录/文件不再由 Gateway 展示；Worker 的差异收集只发本轮顶层常规文件。Gateway 收到真实图片 artifact 后走受限 reader，上传并发送飞书 `image` 消息；任何图片交付失败只体现在当前处理卡，运行结果保持原样。

## 10 开放问题

1. ~~未授权消息：静默忽略还是礼貌拒绝卡？~~ **已解决（M1）**：可配置 `unauthorizedCardText`，默认礼貌拒绝且不消耗配额（不产生任何运行）。
2. ~~`/clear` 语义：新 sessionId 映射（保留旧会话）还是 fork？~~ **已解决（M1）**：新代次映射 + 旧会话保留。代次持久化于 `stateDir/session-generations.json`（原子写），经 `RunRequest.sessionGeneration` 传给 worker（sessionId = `session-<scopeKey>:<代次>`）。
