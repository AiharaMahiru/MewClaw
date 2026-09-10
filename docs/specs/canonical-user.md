# dsh-canonical-user SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-canonical-user` |
| 位置 | `packages/identity/canonical-user/` |
| 角色 | Definition + PostgreSQL/Memory Provider；Auth Producer；Billing Consumer |
| 里程碑 | M8 |
| 状态 | implementing |
| 关联 ADR | ADR-2、ADR-6 |
| 依赖能力 | `ctx.credentials`、`dsh-lark-contracts`、PostgreSQL |
| 提供能力 | `ctx.canonicalUsers?: CanonicalUserResolver` |

## 1 目的与边界

本能力把 Web Auth UUID 与飞书外部身份解析为稳定 `principalId`，让 Billing 以统一主体归属额度，
同时保留解绑前历史 principal，避免重绑把旧账转给新用户。原始五元 Scope
`tenant/bot/deployment/user/conversation` 不被改写；canonical identity 只增加计费归属投影。

非目标：

- 第一阶段不修改 Auth、Billing、Gateway、Worker bundle 或数据库中的既有业务表。
- 不提供登录、注册、授权、账户合并、额度结算或管理员 HTTP API。
- 不把 `open_id` 当作 Web 用户 ID，不允许 Billing 直查 `auth_` 表。
- 不向模型、SessionEventMap、浏览器、Worker/Admin Context 暴露 Writer、Store、连接池或 SQL。
- 不把目录分离称为沙箱，也不改变 OCI/lightweight/full 的执行隔离。

依赖预算：运行时只复用仓库已有 Cordis、credentials、`pg` 和 PostgreSQL migration runtime；
`@electric-sql/pglite` 仅为无密钥测试依赖。dsh 没有“外部身份可解绑且历史账不转移”的现成能力，
因此需要本能力缝；不新增重量级运行依赖。

## 2 服务契约

```ts
interface IdentityNamespace {
  tenantId: TenantId
  botId: BotId
  deploymentId: DeploymentId
}

type UsageIdentitySource =
  | { kind: "web"; userId: CanonicalUserId }
  | { kind: "feishu"; openId: string }

interface PrincipalResolution {
  principalId: PrincipalId
  canonicalUserId: CanonicalUserId | null
  bindingVersion: number
}

interface CanonicalUserResolver {
  resolveForUsage(input:
    | { namespace: IdentityNamespace; source: { kind: "web"; userId: CanonicalUserId } }
    | { namespace: IdentityNamespace; source: { kind: "feishu"; openId: string }; eventId?: string; occurredAt?: string }
  ): Promise<PrincipalResolution>
  members(input: {
    namespace: IdentityNamespace
    canonicalUserId: CanonicalUserId
  }): Promise<readonly PrincipalId[]>
}

interface CanonicalUserWriter {
  bind(input: BindCanonicalIdentityInput): Promise<CanonicalMutationResult>
  unbind(input: UnbindCanonicalIdentityInput): Promise<CanonicalMutationResult>
}
```

`resolveForUsage` 前置条件是完整 namespace 与合法 UUID/subject；后置条件是同 namespace/source
返回稳定 principal，未知飞书身份以事务创建 provisional principal。eventId/occurredAt 只属于飞书
resolve 命令；Web resolve 携带任一字段必须拒绝，不能静默忽略。飞书 resolve 与 Writer 显式或自动
生成的 eventId 对每个已受理命令全局唯一。`members` 只返回同 namespace 内曾归属于 canonical UUID 的 principals，按创建
时间稳定排序；删除 Auth 用户不删除历史 principal。

Writer 只由 Auth 调用。PostgreSQL Writer helper 必须接受带运行时品牌的调用方 transaction
executor，以便未来和 Auth private identity 在同一事务提交；直接传 Database/pool 必须拒绝。同一
transaction executor 最多执行一个 canonical Writer 命令，第二个命令在 SQL 前硬拒绝并使调用方事务
整体回滚，避免跨身份/事件批处理形成逆序 advisory lock；批量调用必须拆成独立事务。
Memory Writer 仅用于无密钥测试与本地组合。Cordis Context 只声明 Resolver 两个方法，Writer 不进入
Context，也不向 Worker/Admin 暴露。

业务结果：

```ts
type CanonicalMutationFailure =
  | { ok: false; code: "EXPECTED_VERSION_MISMATCH"; currentVersion: number }
  | { ok: false; code: "IDENTITY_ALREADY_BOUND" }
  | { ok: false; code: "IDENTITY_NOT_BOUND" }
  | { ok: false; code: "CANONICAL_USER_MISMATCH" }
  | { ok: false; code: "EVENT_ID_CONFLICT" }
  | { ok: false; code: "INVALID_INPUT" }
```

无效边界输入是调用方 bug，返回 `INVALID_INPUT`；业务冲突返回判别联合；数据库、migration、凭证和
连接故障抛出脱敏环境错误。Provider 是进程级共享实例：解析凭证后建连接，立即注册幂等 close effect，
迁移成功且仍 active 才 provide；初始化期间 dispose 必须立即开始关闭且最终不 provide。

## 3 配置契约

```ts
interface Config {
  databaseUrlEnv: string
}
```

| 字段 | 语义 | 默认值与 resolve | 校验 | 变更影响 |
| --- | --- | --- | --- | --- |
| `databaseUrlEnv` | PostgreSQL 连接串的 CredentialRef | 无默认值；`apply` 建连接前通过 `ctx.credentials.resolve` 显式解析 | 必填；必须通过 dsh `credentialRef()` 的 POSIX 环境变量名语法；不得接受 URL/密钥值 | 运行中只记录脱敏重启告警；重启后生效 |

连接串值永不进入 cordis.yml、错误、日志、事件或测试快照。缺失或非法引用 fail loud，但错误只说明
“数据库凭证引用无效/未配置”，不得回显配置内容。

## 4 事件契约

第一阶段不发布或消费 Cordis typed event，也不修改 `SessionEventMap`。原因是绑定状态必须先以数据库
事务事实落盘，尚无已实施 Dispatcher/Consumer；不能把同进程 emit 伪装成跨进程交付。

持久 outbox payload：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `eventId` | UUID | 幂等键；与 command journal 共用 |
| `eventType` | `identity-provisioned \| identity-bound \| identity-unbound` | 已提交状态变化 |
| `outcome` | `created \| bound \| unbound \| unchanged` | 已提交结果 |
| `namespace` | `IdentityNamespace` | 完整三维归属；不含可伪造的 Web owner |
| `bindingId` / `principalId` | branded UUID | interval 与历史主体 |
| `canonicalUserId` | UUID 或 `null` | 该版本归属 |
| `bindingVersion` | 正整数 | 单身份单调版本 |
| `subjectDigest` | 64 位小写 SHA-256 | 唯一允许离开 binding 表的 subject 表示 |
| `occurredAt` | ISO 时间 | 已提交事件时间 |

未来 Dispatcher 采用 lease + at-least-once；Consumer 必须按 eventId 幂等。该事件不进入 session log，
也不具备 `@mode` Cordis 事件语义；新增 Dispatcher 时须先把 SPEC 状态退回 review。

## 5 模型可见面

无。本包不注册工具、不注入 prompt、不呈现 generic/terminal/diff/locations 内容。身份归属只影响
Billing admission，不能成为模型可见输入，因此没有 session 事件承载映射；这符合“模型可见当且仅当
已落盘”，因为本能力的模型可见集合为空。

## 6 行为契约

核心不变量：

- namespace 是 `tenant/bot/deployment`，同一 subject 跨 namespace 必须隔离。
- Web UUID 对应稳定 web principal；飞书未知身份对应唯一 active interval。
- 缺省 `expectedVersion` 的 missing bind 是受支持的 first-contact bind；提供版本表示调用方声明已有 interval。
- principal claim 只允许 `null -> canonical UUID` 一次；数据库触发器拒绝非空 owner 变化或清空。
- 解绑关闭旧 interval 并创建新 provisional principal；旧 principal 永久留在旧 canonical 用户成员中。
- 同一身份任意时刻恰有一个 active interval；版本每次 bind/unbind 加一。
- `occurredAt` 不得早于 active `validFrom`，也不得晚于本次命令取得的服务器时间；未来或倒序输入返回
  `INVALID_INPUT`，不触发 SQL constraint 错误。interval/outbox 使用受理的 occurredAt，command journal
  `completedAt` 始终使用服务器时间，调用方时间不能推进命令完成时间线。
- 每个已通过语法校验的 eventId 先进入 command journal：同 eventId+digest 永远重放原
  resolution/成功/失败结果；不同 digest 返回 `EVENT_ID_CONFLICT`。环境事务失败不提交 journal。
- command journal、outbox、日志和错误不保存 raw subject；binding 表是唯一 raw subject 持久位置。
- 运行开始时 Billing 应冻结 `{principalId, canonicalUserId, bindingVersion}` admission；运行中解绑不改旧账。

PostgreSQL schema 由两步迁移组成：

1. `canonical-user/001_principals_bindings_outbox` 创建 principals、binding intervals 与 delivery outbox。
2. `canonical-user/002_command_journal_members_index` 创建不含 subject 的 command journal、members
   lookup index 与 principal write-once claim trigger。

`canonical_user_commands` 保存 `eventId/commandDigest/resultJson/completedAt`；`resultJson` 仅允许
Resolver/Writer 的类型化返回值，并在读取边界校验。全局 event advisory lock 必须先于 identity lock，
锁顺序固定为 `event -> identity -> active row/principal row`，避免不同 identity 复用 eventId 时产生
SQL 23505 或死锁。同身份并发 ensure 依靠数据库 transaction advisory lock、partial unique 与
`FOR UPDATE` 收敛，不能用进程内锁替代。

强原子边界：ensure 的 principal+interval+outbox+journal、bind 的 future Auth identity+
claim+close/open interval+outbox+journal、unbind 的 future Auth identity delete+rotate+close/open+
outbox+journal必须同事务提交。失败全部回滚，不允许跨 Provider 分布式事务。

| 触发条件 | 观测结果 | 恢复方式 |
| --- | --- | --- |
| namespace/UUID/subject/时间/版本结构或语法非法、时间晚于服务器 | `INVALID_INPUT`，零写入 | 修正输入并使用新 eventId |
| Web resolve 携带 eventId/occurredAt | `INVALID_INPUT`，零写入 | 删除飞书命令专属字段 |
| 同一 transaction executor 执行第二个 Writer 命令 | 抛脱敏调用方错误，事务回滚 | 每个 Writer 命令使用独立事务 |
| 时间早于 active interval | `INVALID_INPUT`，journal 固化该业务结果 | 修正时间并使用新 eventId |
| expectedVersion 过期 | `EXPECTED_VERSION_MISMATCH(currentVersion)`，journal 固化 | 重新解析版本并使用新 eventId |
| identity 无 active interval，bind 未提供 expectedVersion | first-contact bind，创建已 claim 的 v1 interval | 无需预热；按原 eventId 重放结果 |
| identity 无 active interval，bind 提供 expectedVersion 或执行 unbind | `IDENTITY_NOT_BOUND`，journal 固化 | 先 `resolveForUsage`，再用新 eventId bind/unbind |
| identity 已属于其他 canonical user | `IDENTITY_ALREADY_BOUND` | 显式解绑后用新 eventId 重试 |
| unbind 用户不是当前 owner | `CANONICAL_USER_MISMATCH` | 重新确认当前绑定；不得覆盖 |
| 相同 eventId、不同 digest | `EVENT_ID_CONFLICT` | 调用方生成新 eventId；不得复用 |
| migration/连接/SQL/数据损坏 | 抛脱敏环境错误，事务回滚，admission fail closed | 修复环境后可重放原 eventId |
| 初始化期间 dispose | 立即开始 close，迁移完成后不 provide | 宿主按生命周期重新装载 |
| 凭证引用更新 | 脱敏 restart-required 告警 | 重启 Provider |

## 7 安全与信任

不可信输入包括所有 namespace、UUID、openId、eventId、时间和 expectedVersion；只在解析/持久化边界
运行时校验。调用方提交的 openId、eventId、principalId、bindingId 或卡片 payload 都不是授权证据。
未来 Auth Producer 必须以已认证 Web session 和服务器端 pairing state 解析 canonical UUID；Billing
Consumer 必须使用当前完整 Scope 与 Resolver 结果。

授权与 fail-closed 清单：

- Gateway 不挂载 Provider，飞书面绝不获得 Writer 或工作区工具能力。
- Context 仅含 Resolver；Writer helper 要求带品牌 transaction executor，直接 Database/pool 拒绝。
- Billing/Admin 只能按 canonical UUID+namespace 查 members，禁止按 raw openId 管理额度。
- 所有 SQL 参数化；members 查询必须命中 non-null canonical lookup index。
- 数据库 claim trigger 是 trusted-writer 之外的第二道防线，拒绝历史 owner 转移。
- 任何 PostgreSQL error detail 在离开 Provider 前转换为只含安全 SQLSTATE 的通用错误，不携带 raw row。
- Resolver 故障阻止计费 admission，不回退 raw openId；缺失 `ctx.canonicalUsers` 的未来 Consumer fail loud。

## 8 测试契约

- `unit`：Memory 未知飞书身份并发 ensure、Web 稳定 resolve、members namespace 隔离。
- `unit`：pre-bind -> bind、重复 unbind unchanged、missing identity failure、unbind rotate、rebind 旧账不转移。
- `unit`：expectedVersion 成功/失败；所有成功和业务失败的 eventId 原结果重放；不同 digest 冲突。
- `unit`：倒序/未来 occurredAt 在 Memory/PostgreSQL 都返回 `INVALID_INPUT` 且零 interval/outbox 变化；
  journal completedAt 由服务器时间产生。
- `security`：Web resolve 拒绝 eventId/occurredAt；null/错误类型边界统一为脱敏 `INVALID_INPUT`。
- `unit`：同一 PostgreSQL transaction executor 的第二个 Writer 命令被拒绝且四表整体回滚。
- `unit`：故障注入覆盖 principal、binding、outbox、command journal，验证同生共死。
- `security`：跨 namespace 同 subject 隔离；Context 无 Writer；Database 不能伪装 transaction executor。
- `security`：outbox、journal、序列化错误不含 raw subject；URL 形配置不得出现在凭证错误。
- `security`：直接 SQL 尝试修改/清空已 claim owner 被数据库 trigger 拒绝。
- `unit`：Provider 凭证缺失/非法 fail loud、迁移早于 provide、dispose during init 立即 close 且只一次。
- `e2e`：显式设置 `DSH_CANONICAL_USER_TEST_DATABASE_URL` 且数据库名含 `test` 时，在随机 schema、
  两个独立连接上验证 advisory lock、event 冲突、partial unique、`FOR UPDATE` 与事务回滚；未配置显式 skip。
- `snapshot`：无。第一阶段没有用户/模型可见输出；结构化状态使用精确对象断言而非 UI snapshot。

第一阶段门禁：定向 Vitest、包 build/typecheck、目标 ESLint、workspace/lockfile 注册、函数/文件复杂度、
`git diff --check` 与独立 code review。全仓既有失败不得掩盖本包失败。

## 9 迁移映射

| 来源 | 处置 | 说明 |
| --- | --- | --- |
| `packages/auth/auth` 的 Web UUID | 复用 | 只把 UUID 作为 canonical user；第一阶段不修改 Auth 表 |
| `packages/auth/auth` 的 `auth_identities` | 重写（后续） | Auth 仍是唯一 bind/unbind Producer；后续在同事务调用 Writer helper |
| 飞书五元 Scope / `open_id` | 复用 | Scope 原样保留；raw subject 仅存 binding 表 |
| `packages/lark/billing` 的 openId/UUID 双轨归属 | 重写（后续） | 改为 Resolver admission + principal members，不直查 Auth |
| DoorAgent 用户及关联账本 | 不在本阶段迁移 | 由 DoorAgent ETL 使用已确认 source-user -> Auth UUID 映射 |

行为变化：新增 provisional principal、历史 interval、command journal 和 outbox；解绑不再删除或转移历史
计费主体。现有 Auth/Billing/运行行为在第一阶段保持不变，跨进程接入不得被宣称已完成。

## 10 开放问题

1. M8 / Auth owner：何时把 pairing bind/unbind 与 Writer helper 合并为同一 PostgreSQL 事务？阻塞生产接入，
   不阻塞第一阶段 Provider。
2. M8 / Billing owner：何时把 quota admission 与 ledger attribution 改为 canonical principal？阻塞统一额度，
   不阻塞第一阶段 Provider。
3. M8 / Runtime owner：是否实施 outbox Dispatcher 与 `canonical-user/changed` Cordis event？实施前须回到
   review 并补事件声明、Consumer 与 at-least-once E2E。
