# DoorAgent 关联数据迁移 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-dooragent-migration` |
| 位置 | `packages/migration/dooragent` |
| 角色 | Definition + Provider + Consumer + Plugin |
| 里程碑 | M8 / 子任务 6 |
| 状态 | accepted |
| 关联 ADR | [migration-blueprint.md ADR-13](../migration-blueprint.md#adr-13-生产替换dsh-是唯一运行架构) |
| 依赖能力 | `ctx.auth`、`ctx.billing`、`ctx.larkSessionDirectory`、`ctx.knowledge`、`ctx.memory`、工作区 Provider |
| 提供能力 | 细化 `ctx.dooragentMigration` 的关联数据阶段，不新增服务键 |

## 1 目的与边界

本契约把 DoorAgent 冻结快照中的工作区、文件、会话、计费、知识和记忆转换为 DSH 原生数据，并以完整 Scope、已确认身份映射、确定性幂等键和可逆 run 记录约束每次写入。迁移完成后，所有读取和执行仍经过 DSH/Cordis Provider；DoorAgent schema、Qdrant、Mem0 和 Pi JSONL 均不成为运行时依赖。

非目标：

- 不创建或猜测用户，不根据目录名、昵称、邮箱片段或飞书消息推断所有权。
- 不迁移登录 session、cookie、token、验证码或其他临时认证状态。
- 不直接复用 DoorAgent 向量、进程状态、运行时缓存或无可追溯原文的派生摘要。
- 不改变既有 Auth Edge、管理员路径策略、普通用户工作区根、rootless OCI 或 Gateway/Worker 隔离。
- 不删除 DoorAgent 源数据；回滚也不得修改冻结源快照。

## 2 服务契约

本契约不新增公共服务键，沿用 `docs/specs/dooragent-migration.md` 的 `ctx.dooragentMigration`：

| 方法 | 关联数据语义 |
| --- | --- |
| `plan` | 仅接受冻结 manifest 与已确认的源用户到 Auth UUID 映射；生成逐对象 action、完整 Scope、摘要、引用和冲突结果 |
| `dryRun` | 执行解析、Scope、路径、引用、金额、容量和 Provider 探测，不产生业务写入 |
| `apply` | 按依赖顺序调用 DSH Provider，记录每个对象的 preimage、幂等键和 run ownership |
| `reconcile` | 从 Provider 读回目标对象，核对数量、摘要、引用和金额，不以迁移报告自证成功 |
| `rollback` | 只撤销本 run 创建的对象，并对本 run 更新的字段执行 preimage 条件恢复 |

错误分类：

- `IDENTITY_MAPPING_MISSING` / `OWNERSHIP_AMBIGUOUS`：业务冲突；对象拒绝导入并进入清单。
- `SCOPE_INVALID` / `SCOPE_REJECTED` / `REFERENCE_INVALID`：安全门禁；当前对象及其依赖对象不得写入。
- `PATH_ESCAPE` / `CONTENT_DIGEST_MISMATCH` / `UNSUPPORTED_FILE_TYPE`：不可信文件失败；不得静默跳过。
- `SESSION_EVENT_UNMAPPABLE`：历史无法无损转成当前 DSH session 事件；只读归档。
- `BILLING_IDENTITY_CONFLICT` / `BALANCE_MISMATCH` / `QUOTA_CONFLICT`：计费冲突；计费域整体 fail closed。
- `REINGEST_FAILED`：Knowledge/Memory 重摄取失败；保留原文与失败状态，禁止把旧向量作为降级结果。
- `ROLLBACK_CONFLICT`：目标在迁移后已被修改；保留目标并转人工处理。

Provider 随 Cordis context 创建，所有注册和临时资源通过 `ctx.effect()` 清理。同一 `runId` 只允许一个写执行器；不同用户可按有界 `batchSize` 并行，同一用户内按工作区/文件、会话、知识/记忆、计费引用顺序执行。取消后不再领取新批次，已提交批次进入可对账状态。

## 3 配置契约

不增加新的 Cordis Config，避免与总迁移插件产生两套可变项：

| 既有字段 | 默认与校验 | 本阶段影响 |
| --- | --- | --- |
| `sourceSnapshotPath` | 无默认值；必须是只读冻结快照绝对路径 | 所有源路径必须 realpath 包含于该根 |
| `manifestPath` | 无默认值；必须是绝对路径且摘要与快照绑定 | 唯一允许的对象、所有权和摘要输入 |
| `batchSize` | 默认 `100`；整数 `1..1000` | 控制有界并发，不改变结果顺序与幂等性 |
| `includeAssociatedData` | 默认 `false`，配置解析时显式 resolve | 仅经批准计划可改为 `true` |

逐域的 `migrate | archive | reject` 决策属于不可变 plan，不是运行时开关。密钥不属于本契约；只使用现有 DSH 凭证引用。新增运行时依赖为零，文件摘要、路径规范化和精确十进制运算优先使用 Node 标准库与已安装 DSH 能力。

## 4 事件契约

复用总迁移 SPEC 的管理事件，不向 `SessionEventMap` 增加迁移控制事件，也不增加或重命名
payload 字段。关联数据的 domain/action/idempotencyKey 只存在于不可变 plan 和迁移报告，不形成
第二套 wire 契约：

| 事件 | `@mode` / 可忽略 | 必填 payload |
| --- | --- | --- |
| `migration/dooragent-object-result` | `async` / 否 | 公共字段 + `source`、`targetType`、`targetId`、`scope`、`result`、`reasonCode` |
| `migration/dooragent-reconciled` | `async` / 否 | 公共字段 + `matched`、`missing`、`mismatched`、`reportDigest`、`result` |
| `migration/dooragent-rolled-back` | `async` / 否 | 公共字段 + `rolledBack`、`retained`、`failed`、`reportDigest`、`result` |

公共字段与枚举的唯一 home 是 [dooragent-migration.md §4](dooragent-migration.md#4-事件契约)。
`scope` 始终包含 `tenantId/botId/deploymentId/userId/conversationId`；额度结果的
`conversationId` 使用计划中明确的迁移控制 conversation，仅用于审计，额度 Provider 仍按前四维键
工作。事件按 plan、object result、reconciled、rolled-back 的因果顺序发布；object result 允许
至少一次投递，消费者以 `eventId` 去重。事件只含摘要与引用，禁止包含内容正文、密码哈希或凭证。

当前没有可写的官方 session import/persistence 契约。Pi JSONL 只能生成带摘要的只读归档；`ctx.larkSessionDirectory` 仅在目标会话由官方路径创建后处理飞书映射，不得写会话正文、伪造 session event 或把未知字段塞入既有 payload。

## 5 模型可见面

本能力不注册模型工具、不注入提示词，迁移管理事件不进入模型上下文。

| 迁移后模型可见内容 | 持久化来源 |
| --- | --- |
| 历史用户、助手消息 | 当前不进入模型；只读归档等待官方 session import/persistence 契约 |
| 可重放的工具调用与结果 | 当前不进入模型；只读归档等待官方 session import/persistence 契约 |
| Knowledge 检索结果 | 已保存原文、ACL 与 provenance 经 `ctx.knowledge` 重摄取后的目标记录 |
| Memory 检索结果 | 已保存原文/模态、关系与 provenance 经 `ctx.memory` 重摄取后的图记录 |

会话标题、迁移报告、旧向量和 DoorAgent 派生摘要不作为模型输入。任何可见历史都必须能从目标 session log 重建。

## 6 行为契约

### 6.1 状态机与幂等

`inspected -> planned -> dry_run_passed -> approved -> applying -> applied -> reconciled -> cutover_eligible`。任一写失败进入 `partial_failed`，只能继续 `reconcile`、从幂等点重试或 `rollback`；不得把部分成功标记为 `applied`。

外部映射唯一键为 `sourceSystem + domain + sourceId`，目标映射还必须记录 `sourceDigest`、`planId` 和 `runId`。同一三元组且摘要相同的重复 apply 返回既有结果；同一三元组但摘要变化必须返回 `SOURCE_DIGEST_MISMATCH` 并重新 inspect/plan，禁止创建第二条映射。

### 6.2 Scope 与归属

| 域 | 目标归属键 | `conversationId` 语义 |
| --- | --- | --- |
| 工作区/文件 | DSH Auth UUID + Provider 校验后的 canonical path | 记录导入来源；同一用户可在其他会话选择该工作区 |
| 会话/事件 | 完整五维 Scope + `generation/sessionId` | 严格属于该会话，不得跨会话重挂 |
| 额度 policy | `tenantId/botId/deploymentId/Auth UUID` | 不参与额度唯一键 |
| usage ledger | 完整五维 Scope + `run/turn/step/provider/model` | 必须保留源会话归属 |
| Knowledge/Memory | `tenantId/botId/deploymentId/Auth UUID` + ACL | 来源、摄取任务和账本保留会话；同用户可按现有 ACL 跨会话检索 |

所有计划对象都携带严格解析后的五维 Scope；缺字段和未知字段均拒绝。飞书 `open_id/union_id` 仅是 Auth 身份别名，canonical billing identity 永远是目标 DSH Auth UUID。`auth_resources` 只有资源与 user 关系，不能单独证明飞书 Scope 或会话归属。

### 6.3 逐域转换

- **工作区**：一个源工作区只允许一个 Auth UUID owner。普通用户导入到其已分配根内；管理员仍使用现有不限位置策略，但迁移器本身不得扩大路径权限。Session Directory 的 selection 必须引用已存在 binding，完整 Scope、generation 与 sessionId 一致。
- **文件/上传**：只复制普通文件和目录；拒绝路径穿越、根外 realpath、符号链接/重解析点、设备文件和摘要变化。目标已存在同摘要文件记为 merged，不覆盖不同摘要内容。
- **会话**：Pi JSONL 按文件生成数量、字节数和内容摘要后整体只读归档。官方 session import/persistence 契约 accepted 前不写会话正文；`ctx.larkSessionDirectory` 不能替代该能力。
- **计费**：先按身份映射归并全部别名，再生成单一 Auth UUID 额度。usage 使用原 token 分类、provider/model、价格快照和精确整数 micro-credits；禁止浮点金额计算。既有 quota 不存在才创建，相同则保留，不同则 `QUOTA_CONFLICT`，不得自动相加或覆盖。
- **Knowledge**：仅迁移原文、来源元数据和可验证 ACL，Qdrant 向量丢弃；通过目标 Provider 重新嵌入。源侧 final manifest 只允许把 Qdrant 记为唯一 `discarded` 域，且对应明细 manifest 必须显式 `status=derived`、`migration_disposition=discarded` 并保留脱敏 `source_metadata` 与 `ownership_audit`。ACL 必须在向量和词法排名前于 SQL 查询中生效。
- **Memory**：图存储为事实源，Mem0 仅作可重建语义索引。迁移文本、图像引用、工具轨迹、人格、关系和 provenance 后重新摄取；无原文向量拒绝。`tenant_shared` 仍受现有 bot/deployment 外层条件限制。

### 6.4 对账门禁

每域必须同时满足：`source = migrated + merged + archived + rejected`、目标读回数量与 created/merged 引用一致、逐对象内容摘要一致、所有外键可解析。计费另需逐 token 分类、逐账期和总 micro-credits 守恒；价格快照摘要一致。任何未解释差异都阻止 `cutover_eligible`。

### 6.5 回滚

- 删除只针对本 `runId` 创建且当前 `targetId/path + digest + run ownership` 全匹配的对象。
- 合并到既有对象的数据不盲删；只有字段当前值仍等于本 run 写入值时才恢复 preimage，否则报告 `ROLLBACK_CONFLICT`。
- quota 回滚恢复迁移前的存在性和值快照，绝不以“减去迁移额度”代替。
- 文件内容被用户修改后保留；run 创建目录仅在仍为空且 ownership 匹配时删除。
- Knowledge/Memory 删除只按本 run 的摄取来源引用执行；共享或后续引用存在时保留并报告。

### 6.6 失败模式

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| manifest/源摘要变化 | run 停在 pre-apply | 重新冻结并生成计划 |
| Provider/网络中断 | `partial_failed` + 最后幂等点 | reconcile 后安全重试 |
| 引用对象未创建 | 依赖对象 `REFERENCE_INVALID` | 修复上游映射后重新计划 |
| 重摄取失败 | 原文保留、索引不可见 | 有界重试或回滚该摄取来源 |
| 金额/数量/摘要不守恒 | reconcile 失败 | 不切流，生成差异清单 |
| 回滚遇到用户新写入 | `ROLLBACK_CONFLICT` | 保留目标并人工处置 |

## 7 安全与信任

DoorAgent 快照、manifest、JSONL、文件路径、对象 ID、ACL 和金额均是不可信输入。只有已签名/摘要绑定的冻结 manifest、用户迁移产出的 Auth UUID 映射、DSH 服务端管理员批准和目标 Provider 查询结果可作为迁移证据。

| 篡改项 | 工作区/文件 | 会话 | quota | usage | Knowledge/Memory |
| --- | --- | --- | --- | --- | --- |
| `tenantId` | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| `botId` | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝，包括 `tenant_shared` |
| `deploymentId` | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝，包括 `tenant_shared` |
| `userId` | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| `conversationId` | owner 不变时仅允许 Provider 正常重选，禁止篡改迁移 provenance | 拒绝 | 不参与键但审计 Scope 拒绝篡改 | 拒绝 | 现有 ACL 可跨会话检索，写入 provenance 篡改仍拒绝 |
| 缺字段/未知字段 | 拒绝整个请求 | 拒绝整个请求 | 拒绝整个请求 | 拒绝整个请求 | 拒绝整个请求 |

目录名、客户端 header、飞书回调、昵称、外部 identity alias、源 JSON 中自报 owner 和单独一行 `auth_resources` 都不是授权证据。SQL 必须参数化，Knowledge ACL 在查询内过滤；文件必须在打开前后验证 canonical path 与摘要，日志/事件/报告不得包含正文、密码哈希、token、cookie、验证码或密钥。

## 8 测试契约

- `unit`：五维 Scope 严格解析、Auth UUID 归并、幂等键、精确 micro-credit、quota preimage、文件 canonical path 和 digest。
- `unit/property`：输入乱序不改变 plan digest；重复 apply 不重复文件、事件、额度或摄取任务。
- `security`：分别篡改五个 Scope 字段、增删未知字段、伪造 owner、路径穿越、符号链接、TOCTOU 摘要变化、伪造批准，全部按 §7 拒绝。
- `security`：两个普通用户互查工作区、会话、usage、Knowledge、Memory 均拒绝；同用户跨会话只按 §6.2 的现有 Provider 语义通过。
- `security`：验证 Knowledge ACL 在排序前过滤，`tenant_shared` 不跨 bot/deployment 扩权。
- `snapshot`：Pi JSONL 只读归档的数量、字节数、逐文件摘要与恢复验证；官方 session import/persistence 契约 accepted 前不测试或声称正文已导入。
- `integration`：Qdrant/Mem0 夹具只导入原文并重新摄取；final manifest 仅允许 `discarded_domains=["qdrant"]`，删除旧向量后仍可从 DSH 事实源重建索引。
- `integration`：258 个源计费账户别名归并后，逐账期 token 与 micro-credit 合计守恒；quota 冲突 fail closed。
- `fault`：批次中断、磁盘满、数据库失败、重摄取超时可 reconcile 并从幂等点恢复。
- `rollback`：新建对象可撤销；merged 对象不误删；quota 恢复完整 preimage；被修改文件和有后续引用的记忆返回冲突。
- `e2e`：生产快照副本完成全域 dry-run/apply/reconcile/rollback；无密钥环境运行夹具，真实生产演练仅在独立批准门禁下执行。

## 9 迁移映射

| DoorAgent 来源 | DSH 目标 | 处置 |
| --- | --- | --- |
| 用户目录/工作区 | Auth UUID scoped workspace | 唯一 owner、路径与摘要通过后重写导入 |
| uploads/普通文件 | 工作区或上传 Provider | 复制字节；不支持对象归档 |
| Pi JSONL | 带摘要的只读迁移归档 | 官方 session import/persistence 契约 accepted 前阻塞正文导入 |
| billing account/quota | 四维 `billing_quotas` | 身份别名先归并；冲突拒绝 |
| usage/ledger/snapshot | 五维 `billing_usage_ledger` | 价格快照和金额守恒后重写 |
| Qdrant point/vector | `knowledge-postgres` | 向量删除；final manifest 仅允许显式 `derived/discarded`，原文、ACL 重摄取 |
| Mem0 vector/memory | PostgreSQL memory graph/cubes | 原文、多模态引用、关系重摄取 |
| resource owner 行 | Auth resource mapping | 只作交叉校验，不作 Scope 唯一真源 |
| 无 owner/摘要/原文对象 | 只读迁移归档 | 不进入 DSH 业务 Provider |

行为变化：工作区从目录推断改为 Auth UUID 显式所有权；Pi JSONL 当前改为只读归档而非直接注入 DSH；计费别名统一到 Auth UUID；Knowledge/Memory 从旧向量直接查询改为 DSH 事实源重摄取；回滚从目录级删除改为 run ownership 与 preimage 条件恢复。

## 10 开放问题

1. DoorAgent 余额、充值与 quota 的结算基准及精确换算规则尚待迁移负责人确认；阻塞计费域 apply，不阻塞其他域 dry-run。
2. 577 个 Pi JSONL 中各事件版本的无损映射覆盖率尚待会话迁移演练给出；阻塞未覆盖会话导入，默认只读归档。
3. 1,280 个顶层工作区和 258 个计费账户的唯一 owner 清单尚待冻结 manifest 确认；阻塞对应对象 plan，禁止人工猜测。
