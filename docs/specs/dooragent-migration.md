# DoorAgent 到 DSH 生产迁移 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-dooragent-migration` |
| 位置 | `packages/migration/dooragent` |
| 角色 | Definition + Provider + Consumer + Plugin |
| 里程碑 | M8 |
| 状态 | implementing（ADR-13 accepted，契约评审通过后进入实现） |
| 关联 ADR | [migration-blueprint.md ADR-13](../migration-blueprint.md#adr-13-生产替换dsh-是唯一运行架构)；[linux-production-runtime.md](linux-production-runtime.md) |
| 依赖能力 | `ctx.auth`、`ctx.billing`、`ctx.larkSessionDirectory`、`ctx.knowledge`、`ctx.memory`；Linux 生产 Runtime |
| 提供能力 | `ctx.dooragentMigration` |

## 1 目的与边界

本能力只负责把 DoorAgent 冻结快照中的注册用户、角色和兼容密码凭证转换并导入 DSH，同时提供 dry-run、幂等、冲突报告、对账和回滚记录。迁移完成后，生产只运行 DSH；DoorAgent 不是运行时依赖。

非目标：

- 不运行 DoorAgent 业务代码，不嵌入其 Runtime、Web 或数据库访问层。
- 不迁移 DoorAgent 工作区、会话、模型配置、运行配置、计费、知识、记忆或文件数据；这些域只保留独立恢复归档。
- 不自动推断孤儿工作区、会话或计费账户的用户归属。
- 不绕过 DSH Auth、Scope、Billing、Session、Knowledge 或 Memory Provider 直接写生产表。
- 不把 `ctx.larkSessionDirectory` 当作会话正文导入器；它只管理飞书会话映射，不写 session events。
- 不由迁移插件解析或记录生产凭证；本地 DSH `.env` 按用户明确授权通过部署通道原样传输，插件仍只接收既有凭证引用。

VPS 发布、独立 PostgreSQL、rootless Podman、systemd、Nginx 切流、快照恢复与 `.env`
传输由 [linux-production-runtime.md](linux-production-runtime.md) 约束。迁移插件只消费该部署组合
生成的不可变 manifest 与 `cutoverEpoch` 引用，不自行管理宿主进程或反向代理。

## 2 服务契约

```ts
interface DoorAgentMigrationService {
  inspect(source: FrozenDoorAgentSource, signal?: AbortSignal): Promise<MigrationInventory>
  plan(inventory: MigrationInventory, policy: MigrationPolicy, signal?: AbortSignal): Promise<MigrationPlan>
  dryRun(plan: MigrationPlan, signal?: AbortSignal): Promise<MigrationReport>
  issueApplyApproval(plan: MigrationPlan, cutoverEpochId: string, signal?: AbortSignal): Promise<MigrationApproval>
  issueRollbackApproval(runId: MigrationRunId, signal?: AbortSignal): Promise<MigrationApproval>
  apply(plan: MigrationPlan, approval: MigrationApproval, signal?: AbortSignal): Promise<MigrationReport>
  syncCredentials(runId: MigrationRunId, source: FrozenDoorAgentSource, signal?: AbortSignal): Promise<MigrationCredentialSyncReport>
  reconcile(runId: MigrationRunId, signal?: AbortSignal): Promise<ReconciliationReport>
  rollback(runId: MigrationRunId, approval: MigrationApproval, signal?: AbortSignal): Promise<RollbackReport>
}
```

- `inspect` 只读取冻结快照，输出记录数、稳定 ID、所有权边和内容摘要，不输出凭证材料。
- `plan` 产生不可变计划；相同输入摘要和策略必须产生相同 `planId`。
- `dryRun` 执行全部解析、唯一性、Scope、配额守恒和引用完整性检查，但不得持久化业务数据。
- `issueApplyApproval` 是一次性管理面的显式外部签发入口；`apply` 禁止自行签发整批批准。
- 一次性 Migration App 必须提供管理员专用 `approve-apply` 编排命令：先对当前确定性 plan
  调用 `issueApplyApproval`，再在同一进程内把批准引用交给 `apply`。批准引用只存在于进程内存，
  不写入迁移状态、文件、stdout、stderr 或证据；普通 `apply --approval-ref` 仅保留给受控外部
  编排和同一批准仍可用时的恢复流程。
- `issueRollbackApproval` 只接受已执行且未回滚的持久化 run，并从该 run 读取原
  `cutoverEpochId` 签发独立 `rollback-run` 批准；调用者不得覆盖 epoch。一次性 App 的管理员
  `approve-rollback` 同样只在进程内把该引用交给 `rollback`，不写入或输出批准引用。
- `apply` 仅接受与计划绑定、未过期且具管理员权限的服务端批准引用；任何目标写入前必须先调用
  `ctx.auth.authorizeImportRun`，由 Auth 以 `apply-run` 原子消费批准并校验 canonical
  `planDigest`、run/plan、manifest source、snapshot、epoch、Scope 与 operator/session。
- `syncCredentials` 只允许在原 `complete` run 上补同步密码，必须复用原 run/plan/snapshot/epoch、
  apply report 的真实 target user 和同一冻结源。它不得重新 `plan`、创建新 run、领取 action/outbox、
  写关联资源或放宽 source mapping 冲突；每个用户仍由当前 active admin 独立签发并消费
  `sync-credential` 批准。历史 run actor digest 不作为 catch-up operator 身份，其他 apply、
  reconcile 和 rollback 继续要求原 actor digest 完全一致。
- `reconcile` 对比源 manifest、迁移报告和 DSH Provider 查询结果。
- `rollback` 只撤销对应 `runId` 创建的对象；合并到既有用户的数据不得盲目删除。

错误分类：

- `SOURCE_NOT_FROZEN`：源仍可写，属于环境故障。
- `SOURCE_DIGEST_MISMATCH`：快照变化，必须重新 inspect。
- `IDENTITY_CONFLICT`：稳定身份已归属其他 DSH 用户，属于需人工处理的业务冲突。
- `CREDENTIAL_UNSUPPORTED`：密码哈希不兼容，用户进入重置流程。
- `OWNERSHIP_AMBIGUOUS`：关联数据无唯一所有者，拒绝迁移该对象。
- `SCOPE_REJECTED`：目标 Provider 拒绝 Scope，属于安全门禁失败。
- `BALANCE_MISMATCH`：计费金额或 ledger 不守恒，拒绝计费迁移。
- `APPROVAL_INVALID`：批准引用无效、过期或与计划不匹配，属于调用方错误。

生命周期：Provider 随 Cordis context 创建，通过 `ctx.effect()` 注册并清理临时 reader、事务和中断监听。任一取消必须停止后续写入并返回可恢复状态。

`ctx.larkSessionDirectory` 的稳定面仅包含飞书会话的 issue claim、current/list、claim/use、
new/unlink 与 resolve。它不能创建、校验或导入 DSH session event log，也不提供历史消息持久化
事务。会话正文迁移在官方 DSH session import/persistence 契约明确并形成独立 SPEC 前保持
阻塞；当前阶段只允许生成带摘要的只读归档，禁止直接写官方表、伪造映射或声称会话已迁移。

失败模式：

| 触发条件 | 观测结果 | 恢复方式 |
| --- | --- | --- |
| 快照未冻结、manifest 越界或摘要变化 | `SOURCE_NOT_FROZEN` / `SOURCE_DIGEST_MISMATCH`，零目标写入 | 重新冻结、验证并生成新 plan |
| 稳定身份、邮箱或外部映射冲突 | 对象结果为 `IDENTITY_CONFLICT`，同批其他对象按计划继续 | 管理员处理冲突后生成新 plan |
| 凭证格式不在严格白名单 | 用户结果为 `reset_required`，报告只含原因码 | 用户走邮箱验证码重置，不导出源哈希 |
| 关联对象缺少唯一所有权或完整 Scope | `OWNERSHIP_AMBIGUOUS` / `SCOPE_REJECTED`，拒绝该对象 | 修复所有权映射后重新 plan |
| 计费金额或 ledger 不守恒 | `BALANCE_MISMATCH`，计费阶段零写入 | 冻结结算基准并重新对账 |
| 批准过期、复用或绑定不一致 | `APPROVAL_INVALID`，零目标写入 | 重新签发与 plan/snapshot/epoch 绑定的批准 |
| 取消、进程退出或数据库事务失败 | 当前事务回滚，run 标记可恢复，outbox 不发布未提交事件 | 使用同一 plan 幂等重试并 reconcile |
| outbox 投递失败或租约过期 | 事件保留未 ack 状态，可观测重试计数 | 按原 eventId/sequence 重放，消费者去重 |
| rollback 无法证明无迁移后业务写入 | `ROLLBACK_GUARD_UNAVAILABLE`，双方保持只读 | 完成 epoch delta 对账后人工决定 |

## 3 配置契约

```ts
interface Config {
  sourceSnapshotPath: string
  statePath: string
  manifestPath?: string
  batchSize?: number
  approvalTtlMs?: number
  allowCredentialReuse?: boolean
  includeAssociatedData?: boolean
  maxRecordBytes?: number
  maxTotalBytes?: number
  maxPathDepth?: number
  outboxBatchSize?: number
  outboxLeaseMs?: number
}
```

Config 在 Provider `apply` 开始时一次性 resolve；非法值在连接任何目标 Provider 前 fail loud：

| 字段 | 默认值 | 校验与变更影响 |
| --- | --- | --- |
| `sourceSnapshotPath` | 无，必填 | 绝对路径、已冻结且只读；禁止指向 DoorAgent 活跃数据库；变更需重启并重新 inspect |
| `statePath` | 无，必填 | Migration 自有 SQLite 状态文件的绝对路径；父目录最小权限、文件 `0600`，不得与源快照或 DoorAgent 活跃目录重叠 |
| `manifestPath` | `<sourceSnapshotPath>/manifest.json` | 必须位于快照根内且是普通文件；变更需重新 inspect |
| `batchSize` | `100` | 整数 `1..1000`；仅影响单事务批量，不改变计划摘要 |
| `approvalTtlMs` | `900000` | 整数 `60000..3600000`；只影响新批准引用 |
| `allowCredentialReuse` | `false` | 仅在 Auth 严格白名单通过时生效；变更需重新 plan |
| `includeAssociatedData` | `false` | 生产策略固定为 `false`；设为 `true` 必须 fail loud，不生成关联数据计划 |
| `maxRecordBytes` | `8388608` | 整数 `1024..16777216`；单记录解码前门禁 |
| `maxTotalBytes` | `21474836480` | 整数 `1048576..1099511627776`；快照总读取预算 |
| `maxPathDepth` | `32` | 整数 `1..64`；归档和工作区路径深度门禁 |
| `outboxBatchSize` | `100` | 整数 `1..1000`；每轮事件领取上限 |
| `outboxLeaseMs` | `300000` | 整数 `1000..86400000`；失败投递在租约后可重领 |

- 密钥字段不存在；数据库和服务访问使用 DSH 凭证引用。
- `.env` 不属于本插件 Config；由部署步骤以不回显内容的方式传输，验证源/目标 SHA-256 一致并设置服务账户最小读取权限。

依赖预算：实现只使用 Node 标准库、仓库既有 Cordis/DSH 契约、`pg` 与现有运行时校验工具；
不得新增 SQLite ORM、ETL 框架、队列或向量数据库依赖。SQLite 源读取器必须保持一次性、只读、
不可变快照边界；迁移编排状态可使用 Node 内置 SQLite 独立落盘，但不得复用源库或 Auth 业务表。
mem0、Qdrant 与 DoorAgent Runtime 不作为依赖安装或加载。

## 4 事件契约

迁移事件声明合并进 Cordis `Events`，不进入 `SessionEventMap` 或普通用户会话流。每个事件均
为 `@mode async`、`ignorable: false`，payload 先过运行时校验和大小门禁：

| 公共字段 | 类型 | 语义 |
| --- | --- | --- |
| `eventId` | UUID string | 首次写 outbox 时生成；重试和重放保持不变，消费方以此去重 |
| `runId` | `MigrationRunId` | 本次 apply/reconcile/rollback 运行 |
| `planId` | `MigrationPlanId` | 与不可变计划绑定 |
| `cutoverEpochId` | UUID string \| null | plan/dry-run 为 `null`；apply/reconcile/rollback 必须绑定已打开或待对账的切流 epoch |
| `snapshotDigest` | 64 位小写 hex | 冻结快照 manifest 的 SHA-256 |
| `sequence` | integer >= 1 | 同一 `runId` 内单调递增；不承诺跨 run 全局顺序 |
| `occurredAt` | ISO-8601 string | 业务事务提交所采用的服务端时间 |
| `ignorable` | `false` | 管理事件不可静默丢弃，失败必须保留待重试 |

| 事件 | 附加 payload 字段 |
| --- | --- |
| `migration/dooragent-planned` | `counts: Array<{ sourceType: string; count: number }>`、`policyDigest: string` |
| `migration/dooragent-user-result` | `source: { sourceSystem: "dooragent"; sourceType: "user"; sourceId: string; sourceDigest: string }`、`targetUserId: string \| null`、`result: "migrated" \| "merged" \| "rejected" \| "reset_required"`、`reasonCode: string \| null` |
| `migration/dooragent-object-result` | `source: { sourceSystem: "dooragent"; sourceType: string; sourceId: string; sourceDigest: string }`、`targetType: string`、`targetId: string \| null`、`scope: Scope \| null`、`result: "migrated" \| "merged" \| "rejected" \| "unchanged"`、`reasonCode: string \| null` |
| `migration/dooragent-reconciled` | `matched: number`、`missing: number`、`mismatched: number`、`reportDigest: string`、`result: "matched" \| "mismatch"` |
| `migration/dooragent-rolled-back` | `rolledBack: number`、`retained: number`、`failed: number`、`reportDigest: string`、`result: "complete" \| "partial" \| "rejected"` |

业务数据、外部映射、审计记录和事件 outbox 行在同一事务提交；dispatcher 只领取已提交行，
投递成功后 ack。一次性 Migration App 还必须在 ack Auth outbox 前，把完整脱敏事件按
`eventId` 幂等写入迁移状态 SQLite 的 durable receipt；相同 `eventId` 或 `(runId, sequence)`
对应不同 payload 时 fail closed。Cordis typed event 是 receipt 之后的扩展投递面，零 listener
可以正常返回，但不能成为唯一审计证据或导致 receipt 缺失。语义为 durable outbox +
at-least-once：同一事件可重复送达，不能在提交前
发布；消费者必须按 `eventId` 幂等。每个 run 的 sequence 在事务内分配，重试不得领取新
sequence。未 ack 或租约过期的行可重放；重放不改变 payload、eventId 或 sequence。任何
payload 都不得包含密码哈希、token、Cookie、密钥、原始邮件地址或模型内容。

上述原子性以单个 Provider 的单对象事务为边界，不引入跨 Provider 分布式事务；跨 Auth、
Billing、Knowledge 与 Memory 的阶段结果由 run 状态、幂等映射和 reconcile 收敛。本包不消费
任何 session event；outbox dispatcher 只消费本包已提交的迁移 outbox 行。

## 5 模型可见面

迁移控制事件不进入模型上下文。只有转换成功且可从 DSH session log 重建的历史消息可被模型读取；Pi JSONL、DoorAgent 派生摘要或 Mem0 数据不得直接注入模型。

## 6 行为契约

本次远端只读核验基线已经确认：DoorAgent 有 16 个 active 用户（3 admin、13 user），邮箱、
名称和工作区标识均无重复；16/16 密码凭证为可严格转换的 scrypt v1。该源格式严格为
`scrypt:<32 lowercase hex>:<128 lowercase hex>`，参数固定 `N=16384`、`r=8`、`p=1`；salt
是 32 个 hex 字符本身组成的 32-byte ASCII 文本，不是 hex 解码后的 16 bytes，derived key
是 128 个 hex 字符解码后的 64 bytes。只有 `sourceSystem=dooragent` 可把两段分别转为
canonical base64url 后写成 DSH `$` 编码；不得泛化任意长度或向其他来源开放。计划、报告和
事件不得写入任何生产哈希值。

源 Auth 数据库没有 Feishu identity 字段或实现，因此 identity 列表必须为空，禁止按邮箱、
昵称或其他字段推断绑定；用户迁移后只能通过现有 MewClaw `/login` 链路重新绑定。该基线在
正式冻结快照时仍须按 manifest 摘要和相同检查重验。

源角色白名单已固定为 `admin -> admin`、`user -> user`；目标 preset/default mode 继续由 DSH
Auth 角色策略决定，不从 DoorAgent 字段推导额外权限。

用户映射顺序：

1. 以 `(sourceSystem, sourceType, sourceId)` 查询既有外部映射并校验 `sourceDigest`。
2. 无映射时按规范化邮箱精确匹配既有 DSH 用户；昵称和飞书邮箱不是合并证据。
3. 无冲突时通过 `ctx.auth.dryRunUserImport` 规划，再由 `applyUserImport` 合并或创建。
4. 角色通过批准计划中的显式白名单转换；未知角色拒绝，禁止复用首 active 用户自动管理员逻辑。
5. 密码只在 `ctx.auth.inspectCredential` 通过 DSH 严格 scrypt 白名单时保留，否则标记 `reset_required`。
6. 每个用户输出 `migrated | merged | rejected | reset_required` 之一。

最终用户迁移要求 16 个目标账户均可使用 DoorAgent 原密码登录。`create` 与 `merge` 均通过原
run 的受控凭证补同步路径处理：当前凭证已等价时零写入；不等价时先写 AES-256-GCM rollback
snapshot，再替换密码并撤销该用户旧 session。成功后只在迁移状态记录 source ID；若远端成功而
本地 checkpoint 失败，重试必须以当前密码等价短路后补记账。源端没有 identity，用户候选不得
携带任何 Feishu subject；绑定统一在迁移后通过 MewClaw `/login` 完成。

关联数据策略：

- 工作区、会话、模型配置、运行配置、计费、知识、记忆和文件全部排除在生产导入之外。
- 已生成的这些域只读 manifest 与源快照保留在独立恢复归档中，不注册为 DSH 资源，不进入模型上下文。
- 历史演练若已写入关联资源，必须通过原迁移 run 的受控 rollback 契约撤销；禁止直接 SQL 或手工删除绕过审计。

幂等映射的唯一键严格为 `(sourceSystem, sourceType, sourceId)`；`sourceDigest` 是该映射的
replay guard，不属于唯一键。同一三元组且摘要相同的重复 apply 返回既有结果，不重复创建
用户、额度、资源或业务事件；同一三元组但摘要变化返回 `SOURCE_DIGEST_MISMATCH`，必须重新
inspect/plan，且不得插入第二条映射。并发 apply 依赖目标数据库唯一约束和事务内重读收敛到
同一结果，不能以进程内锁替代数据库不变量。

迁移编排状态必须跨进程恢复：在授权或写入前持久化原始 source 引用、actor 摘要和脱敏 plan，
整批授权成功后先持久化 `authorized` 阶段与 `cutoverEpochId`，再签发 item approval。重启后的
`apply`、`reconcile`、`rollback` 必须按原 `runId` 恢复原 plan，并重新读取和复核冻结源；不得
通过重新规划当前目标状态生成替代 run。状态库只允许保存 source 引用、稳定 ID、摘要、决策、
计数和脱敏报告，禁止保存邮箱、密码哈希、验证码、token、Cookie、密钥或用户工作区路径。
actor 摘要只绑定完整稳定 Scope 与 operator user，不包含易变的 session/request。相同 run 的跨进程
并发由状态库事务、唯一约束和单调 run fencing token 收敛；每次 operation 必须使用独立 owner，
未过期 lease 即使 owner 文本相同也不能重领。续租、释放、阶段转换、报告/回滚保存、durable
receipt 与 outbox checkpoint 必须在同一状态库原子条件中校验 owner、fence 和 lease 未过期；
过期 owner 不能续租、释放或恢复执行，不能只依赖进程内 `Map`。

final-freeze 根 manifest 必须声明 `discarded_domains=["qdrant"]`。Qdrant 是唯一允许的派生域：
根 domain 状态必须为 `derived`，其 manifest 必须同时为 `status=derived`、
`migration_disposition=discarded`、`rebuild_strategy=reingest-from-facts`；其余事实域必须为 `frozen`，
且 `blocked_domains`、`drift_domains` 都为空。

## 7 安全与信任

- 迁移命令只在 Worker/管理执行面运行，Gateway 和浏览器不得获得源数据库路径或迁移批准材料。
- `apply` 和 `rollback` 需要管理员权限、计划绑定批准和审计事件；浏览器回调载荷只是状态引用。
- SQL 使用参数化查询；路径经 realpath 和快照根约束；归档解析有记录大小、总量和深度上限。
- Auth SQLite 必须只从已完成摘要校验的同一字节序列读取；若 SQLite API 不能直接打开 buffer，
  只能写入独占、最小权限、自动清理的临时副本，禁止再按已校验的源路径二次打开。
- 日志、报告和事件禁止包含密码哈希、验证码、token、cookie、密钥或完整外部凭证。
- `.env` 禁止进入 Git、构建产物、日志和证据；传输过程只允许记录路径、字节数、摘要和权限结果。
- 普通用户导入后必须通过跨 Scope 拒绝测试；目录分离不能作为隔离证明。
- 迁移插件在生产切流和验收结束后默认卸载，保留只读报告与映射表。

## 8 测试契约

- `unit`：邮箱规范化、角色映射、严格 scrypt 白名单、三元组幂等键、摘要 replay guard、冲突分类和金额守恒。
- `contract`：Provider 只能通过 DSH Auth/Billing/Knowledge/Memory 能力写入；`ctx.larkSessionDirectory` 只处理飞书映射，正文导入必须拒绝。
- `property`：重复 dry-run/apply 不重复创建；乱序输入产生相同计划摘要。
- `fault`：取消、磁盘满、事务失败、摘要变化、部分批次失败与进程重启均产生可恢复报告。
- `security`：跨用户 Scope、路径逃逸、symlink/TOCTOU、源文件校验后替换、超大 JSONL、恶意文件名、伪造批准、批准复用和日志脱敏均有拒绝用例。
- `snapshot`：用户与对象结果报告使用清理后的稳定快照，不含邮箱、密码哈希、token 或模型内容。
- `e2e`：生产快照副本完整导入、数量/摘要对账、登录恢复和回滚；无生产快照时只跳过真实数据用例，离线 fixture 门禁不得跳过。
- `credential catch-up`：旧 plan 的 `credentialSync=null` 仍可从原 plan、apply report 与冻结记录重建 create/merge 候选；第二次执行全部跳过；远端成功、本地 checkpoint 失败后可收敛；planned、rolled-back、source mismatch 和 self-sync 均拒绝。
- `production`：管理员与普通用户登录、飞书配对、工作区、会话、额度和 OCI 工程任务；缺少外部凭证时记录显式阻塞，不用本地 mock 代替真实验收。
- `matrix`：Web/Auth/Admin、六个 preset、飞书、上传、知识、记忆、计费、邮件、Cron、模型路由、工作区和异常/中断路径。
- `governance`：迁移触达模块检查生命周期泄漏、错误吞没、越权、N+1/无界 IO、超限函数和重复逻辑；修复必须有定向回归与全仓门禁。

## 9 迁移映射

| DoorAgent | DSH | 处理 |
| --- | --- | --- |
| user | auth user | 邮箱/稳定映射合并或创建 |
| admin/user role | DSH role | 显式白名单转换 |
| password hash | credential | 兼容才保留，否则重置 |
| Feishu identity | 无源字段 | 不迁移、不推断；用户通过 MewClaw `/login` 重新绑定 |
| login session | 无 | 不迁移，用户重新登录 |
| workspace | 无生产映射 | 只读归档，不迁移 |
| Pi JSONL | 无生产映射 | 只读归档，不迁移 |
| billing account/ledger | 无生产映射 | 只读归档，不迁移 |
| Qdrant knowledge | 无生产映射 | 只读归档，不迁移 |
| Mem0 | 无生产映射 | 只读归档，不迁移 |
| Evolution/Program | 无运行时映射 | 进入后续产品路线图 |

切流使用独立 DSH 部署目录和服务单元。`apply` 的批准引用必须同时绑定 `planId`、
`snapshotDigest` 与已打开的 `cutoverEpochId`；迁移 outbox 的 durable reference 进入对应 epoch 的
连续 delta 日志。DoorAgent 在最终增量导出后进入只读，反向代理按 Linux Runtime 契约原子切换。
失败时仅当 epoch delta 为空才允许自动恢复 DoorAgent 可写；存在业务写入时进入
`rollback-pending`，保持双方只读并先完成对账，不能盲目撤销或双写。
Auth Provider 在连续 delta 尚不能证明目标无迁移后业务写入时必须返回
`ROLLBACK_GUARD_UNAVAILABLE`，保留本次创建的用户与资源；禁止仅凭 `createdTarget` 级联删除。

## 10 开放问题

| ID | 待决问题 | 阻塞阶段 | 决策人 | 截止门禁 |
| --- | --- | --- | --- | --- |
| DA-6 | `linux-production-runtime.md` 候选域名、TLS 和反向代理切流窗口的最终批准 | 灰度与切流 | Operations owner + Security owner | 切流演练前 |
| DA-7 | `linux-production-runtime.md` 中 `dsh` 服务账户、部署路径和 `.env` 路径的实机验证 | 生产部署 | Operations owner + Security owner | 首次生产文件传输前 |
