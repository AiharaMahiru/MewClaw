# dsh-lark 多用户认证 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-auth`（Definition + Provider）+ `dsh-lark-auth-edge`（认证边界）+ `apps/auth`（App） |
| 位置 | `packages/auth/auth/`、`packages/auth/edge/`、`apps/auth/` |
| 角色 | Auth Definition/Provider/Consumer；官方 Worker/Admin 继续作为被代理服务 |
| 里程碑 | M7 |
| 状态 | implementing |
| 依赖能力 | `ctx.credentials` |
| 提供能力 | `ctx.auth?: AuthCapability` |

## 1 目的与硬边界

本 SPEC 为官方 dsh Web 增加产品级多用户身份层。它不替换官方聊天 UI、API、事件协议、会话持久化、Gateway allowlist 或执行沙箱；它只在浏览器与 loopback 服务之间增加身份、授权和审计边界。

拓扑固定为：

```text
浏览器 -> auth-edge（浏览器唯一入口） -> 127.0.0.1:DSH_WEB_INTERNAL_PORT（官方 Worker Web）
                                      -> 127.0.0.1:ADMIN_PORT（Admin，按管理员策略）
飞书 Gateway ------------------------------------------> Worker /v1（原有 WORKER_TOKEN）
```

Worker/Admin 只绑定 loopback；`WORKER_TOKEN`、`ADMIN_TOKEN`、数据库连接和 Feishu app secret 不进入浏览器。普通用户可选择当前 Worker 暴露的系统 preset，但不会因此获得管理员角色、宿主任意路径或用户 preset 根；full/OCI 的实际执行边界仍由 Worker profile 决定，当前生产使用 OCI。lightweight profile 仍只暴露轻量 preset，并对不可用的执行能力 fail closed。

## 2 身份、角色与生命周期

### 2.1 用户

`auth_users`：`id`（UUID）、`email_normalized` 唯一、`display_name`、`role`（`admin|user`）、`status`（`pending|active|disabled`）、`default_mode`（`full|lightweight`）、时间戳。首个完成邮箱验证或 Feishu OAuth 注册的用户以事务锁创建为 `admin/full`；后续用户为 `user/lightweight`。管理员默认 preset 为 `lark-standard`（展示名“飞书全功能模式”），普通用户默认 `lark-lightweight`，但会话模式可选择当前部署暴露的全部系统 preset。首用户自动管理员规则只属于正常注册链路；迁移导入必须使用批准计划中的显式角色映射，禁止复用该规则提升源用户。

管理员角色控制管理面授权和默认 preset，不改变 Worker 的部署 profile；若 supervisor 运行 OCI，所有用户选择的执行型 preset 都仍在 OCI；若运行 lightweight，Worker 只暴露轻量 preset。管理员用户更新接口允许显式修改 `role`，但必须在同一事务内保留至少一个 `active` 管理员，并强制 `admin/full`、`user/lightweight` 默认模式配对；默认模式与会话 preset 选择权限分离。该入口用于受审计的多用户管理和迁移角色校正，不得绕过 Auth 服务直接写库。

一次性迁移工具在没有可复用管理员会话时，可通过仅进程内可调用的 Auth Service 方法签发固定 10 分钟的操作员 session。目标必须是 `active admin`，生成的随机 token 不返回调用方且该方法不暴露 HTTP；签发与迁移完成后的撤销都必须进入 Auth 审计。

DoorAgent 关联数据撤销使用 Auth 的事务化 workspace 清理契约：只处理指定 import run 下尚未回滚的 `source_type=workspace` mapping，并要求 mapping 与 `auth_resources` 的资源 ID、用户 ID 一一匹配。调用者必须提供有效的 active admin session；任一映射漂移时整批零写入失败。成功时只删除对应 workspace ownership 并标记 mapping 已回滚，不触碰用户、凭证、Web session 或 DSH 原生资源。

### 2.2 凭证与会话

- `auth_password_credentials` 保存 `scrypt` 参数、随机盐和派生值，不保存明文或可逆密钥。
- `auth_sessions` 保存 SHA-256(session token)、用户、创建/过期/最后使用时间、撤销时间、IP/UA 摘要；明文 token 只在创建响应的 HttpOnly Cookie 中出现。
- `auth_email_tokens` 保存验证验证码或重置 token 的摘要、用途、过期和消费时间；凭证一次性，邮箱验证码摘要绑定用户 ID。
- `auth_oauth_states` 保存 Feishu state 摘要、短期过期、一次性消费、可选用户 ID 和 return path；不保存 access token。
- `auth_identities` 保存 `provider=feishu`、Feishu `open_id`/`union_id` 摘要和用户关系，provider+subject 唯一。
- `auth_audit_log` 记录成功/失败动作、用户（如已知）、request id、IP/UA 摘要和时间；不得写入密码、Cookie、OAuth code、邮件 token 或模型内容。

### 2.3 Scope、工作区和会话归属

认证用户 ID 映射到官方 Web 请求的归属策略，不替换飞书五元 Scope。边界为每个用户派生稳定目录：`.workspaces/auth/users/<userId>/`；认证会话首次使用时自动初始化该目录。普通用户可通过官方 `host.listDirectory` 浏览自己的根目录，并通过 `host.createDirectory({ path, name })` 在根内创建单一子目录，再用 `workspace.create({ path })` 接纳已有目录为工作区。`workspace.create`、`session.create.cwd` 和目录原语均按 `realpath`/symlink 规则校验，拒绝 `..`、绝对越界路径和根外条目。管理员默认使用 `.workspaces/auth/admin/<adminId>/`，但管理员的 `workspace.create` 与 `session.create.cwd` 不受该默认根限制，可选择本机任意工作区路径；路径仍原样交由官方 Worker/操作系统处理并记录资源归属与审计。

边界维护 `auth_resources`（`resource_type=session|workspace`、资源 ID、用户 ID、路径、创建时间），并在以下官方 RPC 上做授权：`host.listDirectory/createDirectory`（普通用户仅限自己的根目录）、`session.list/search/create/history/prompt/fork/rename/selectModel/attachment/updateQueue/cancel`、`workspace.list/create/rename/delete/insertBefore/insertSessionBefore/archiveSession`、`agentPreset.list/select/read/copy/remove/openDocument`。未知资源默认拒绝；管理员可读但仍受审计。

### 2.4 Cordis 认证能力缝

Definition 与 PostgreSQL Provider 继续位于既有 `dsh-lark-auth` 包，不新增只做转发的
`auth-postgres` 包。稳定服务键是可选的 `ctx.auth?: AuthCapability`；未挂载时依赖它的迁移行
必须保持 pending/fail loud，不能退化为直写 Auth 表。

```ts
import type { Scope } from "dsh-lark-contracts";

interface AuthImportSource {
  sourceSystem: string;
  sourceType: "manifest" | "user" | "credential" | "identity" | "workspace" | "session";
  sourceId: string;
  sourceDigest: string;
}

interface AuthOperator {
  userId: string;
  sessionId: string;
  requestId: string;
}

interface AuthImportContext {
  scope: Scope;
  operator: AuthOperator;
  runId: string;
  planId: string;
  snapshotDigest: string;
  source: AuthImportSource;
  signal?: AbortSignal;
}

interface AuthWriteContext extends AuthImportContext {
  approvalRef: string;
  cutoverEpochId: string;
}

interface AuthUserImportCandidate {
  email: string;
  displayName: string;
  role: "admin" | "user";
  defaultMode: "full" | "lightweight";
  status: "active" | "disabled";
  passwordEncoded?: string;
}

type CredentialImportDecision =
  | { action: "reuse"; algorithm: "scrypt"; profile: "dsh-native" | "dooragent-scrypt-v1" }
  | { action: "reset_required"; reason: string };

type AuthUserResolution =
  | { kind: "missing" }
  | { kind: "mapping" | "email"; userId: string }
  | { kind: "conflict"; reason: string };

interface AuthUserImportPlan {
  decision: "create" | "merge" | "reject";
  targetUserId?: string;
  credential: CredentialImportDecision;
  candidateDigest: string;
  reasonCode?: string;
}

interface AuthUserImportResult {
  result: "migrated" | "merged" | "rejected" | "reset_required";
  userId?: string;
  mappingCreated: boolean;
  reasonCode?: string;
}

type AuthResourceClaimResult =
  | { result: "claimed" | "unchanged"; userId: string }
  | { result: "rejected"; reasonCode: string };

interface AuthImportReconciliation {
  matched: number;
  missing: number;
  mismatched: number;
}

interface AuthImportRollbackResult {
  rolledBack: number;
  retained: number;
  rejected: number;
  reasonCode?: string;
}

type AuthImportOperation = "apply-run" | "apply-user" | "claim-resource" | "rollback-run";

interface AuthImportActionDefinition {
  actionId: string;
  operation: "apply-user" | "claim-resource";
  sequence: number;
  source: AuthImportSource;
  payloadDigest: string;
}

interface AuthImportActionLeaseBinding {
  actionId: string;
  leaseToken: string;
}

interface AuthImportActionLease extends AuthImportActionDefinition {
  leaseToken: string;
  leaseExpiresAt: string;
}

type AuthImportActionResult =
  | { operation: "apply-user"; result: AuthUserImportResult["result"]; targetUserId: string | null; reasonCode: string | null }
  | { operation: "claim-resource"; result: AuthResourceClaimResult["result"]; targetUserId: string | null; reasonCode: string | null };

interface AuthImportOutboxLease {
  eventId: string;
  actionId: string;
  sequence: number;
  result: AuthImportActionResult;
  occurredAt: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

interface AuthImportLeaseInput extends AuthImportContext {
  cutoverEpochId: string;
  limit: number;
  leaseMs: number;
}

interface AuthImportOutboxAckInput extends AuthImportContext {
  cutoverEpochId: string;
  eventId: string;
  leaseToken: string;
}

interface AuthImportOutboxReceiptInput extends AuthImportContext {
  cutoverEpochId: string;
  afterSequence: number;
  limit: number;
}

interface AuthImportOutboxReceipt {
  eventId: string;
  actionId: string;
  sequence: number;
  result: AuthImportActionResult;
  occurredAt: string;
  acknowledgedAt: string | null;
}

type AuthImportApprovalIssueInput = AuthImportContext & {
  cutoverEpochId: string;
} & (
  | {
    operation: "apply-run";
    planDigest: string;
    actions: readonly AuthImportActionDefinition[];
  }
  | { operation: "apply-user"; candidateDigest: string }
  | {
    operation: "claim-resource";
    resourceType: "session" | "workspace";
    resourceId: string;
    resourcePath?: string;
    targetUserId: string;
  }
  | { operation: "rollback-run" }
);

interface AuthImportApprovalIssueResult {
  approvalRef: string;
  expiresAt: string;
}

interface AuthImportApprovalRevokeInput extends AuthImportContext {
  approvalRef: string;
}

interface AuthImportRunAuthorizeInput extends AuthWriteContext {
  planDigest: string;
  actions: readonly AuthImportActionDefinition[];
}

interface AuthCapability {
  inspectCredential(input: {
    sourceSystem: string;
    encoded: string;
    signal?: AbortSignal;
  }): Promise<CredentialImportDecision>;
  resolveUser(input: AuthImportContext & {
    normalizedEmail: string;
  }): Promise<AuthUserResolution>;
  dryRunUserImport(input: AuthImportContext & {
    candidate: AuthUserImportCandidate;
  }): Promise<AuthUserImportPlan>;
  applyUserImport(input: AuthWriteContext & {
    candidate: AuthUserImportCandidate;
    actionLease: AuthImportActionLeaseBinding;
  }): Promise<AuthUserImportResult>;
  claimResource(input: AuthWriteContext & {
    resourceType: "session" | "workspace";
    resourceId: string;
    resourcePath?: string;
    targetUserId: string;
    actionLease: AuthImportActionLeaseBinding;
  }): Promise<AuthResourceClaimResult>;
  authorizeImportRun(input: AuthImportRunAuthorizeInput): Promise<{ authorized: true }>;
  leaseImportActions(input: AuthImportLeaseInput): Promise<AuthImportActionLease[]>;
  leaseImportOutbox(input: AuthImportLeaseInput): Promise<AuthImportOutboxLease[]>;
  listImportOutboxReceipts(input: AuthImportOutboxReceiptInput): Promise<AuthImportOutboxReceipt[]>;
  ackImportOutbox(input: AuthImportOutboxAckInput): Promise<{ acked: true }>;
  reconcileImport(input: AuthImportContext): Promise<AuthImportReconciliation>;
  rollbackImport(input: AuthWriteContext): Promise<AuthImportRollbackResult>;
  issueImportApproval(input: AuthImportApprovalIssueInput): Promise<AuthImportApprovalIssueResult>;
  revokeImportApproval(input: AuthImportApprovalRevokeInput): Promise<{ revoked: true }>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    auth?: AuthCapability;
  }
}
```

结果必须给出确定状态、目标 ID（如存在）和机器可读原因码，禁止返回 Store、连接池或数据库
行。所有方法只接受一个 input object；所有写操作必须携带完整五元 `Scope`、管理员
`AuthOperator`、`runId`、`planId`、`snapshotDigest`、`AuthImportSource`、服务端批准引用、
`cutoverEpochId` 和可选
`AbortSignal`。Provider 必须按 `AuthOperator.sessionId` 重新解析 active admin；调用方提交的
userId、Scope 或批准引用本身均不是授权证据。Provider 必须从服务端批准存储解析
`approvalRef`，并复核未过期、操作者与 session、完整 Scope 摘要、operation、实际写入 payload
摘要、runId、planId、snapshotDigest、cutoverEpochId 与 source 摘要全部绑定一致。调用方不得提交
自行计算的 payload digest：`issueImportApproval` 只接受上述判别联合，Provider 对 `planDigest`、
`candidateDigest`、资源 claim 或 rollback context 生成唯一 canonical digest。`authorizeImportRun`
只接受 `sourceType=manifest`、operation=`apply-run` 的批准，并把已校验的
`{ planDigest, actions }` 作为 payload digest；
runId、planId、snapshot、epoch、Scope、operator/session 和 manifest source 仍逐项独立绑定。
同一批准不得跨 `authorizeImportRun`、`applyUserImport`、`claimResource` 和 `rollbackImport` 复用；
批准签发与撤销必须经 active admin 会话完成，迁移 Consumer 不得自行写批准表。

批准 Provider 只持久化随机 `approvalRef` 的 SHA-256 摘要；签发记录、撤销状态和对应强制审计
必须在同一事务提交。批准验证使用条件 `UPDATE ... SET consumed_at` 原子消费，不允许普通
`SELECT` 后写入；业务写和批准消费在同一事务，失败时一并回滚。撤销同样以条件更新竞争同一
未消费行，因而 revoke 与 apply 最多一个成功。撤销按摘要、active admin、原签发 session、完整
Scope 摘要、run/plan、snapshot 与 source 精确匹配；过期、已消费、已撤销或上下文不一致均返回
统一 `APPROVAL_INVALID`，不得泄露批准是否存在。Consumer 不导入 Store 或批准表。

能力面刻意不暴露完整 `AuthService`、`AuthStore`、连接池及
`promoteUserAndPurgeOthers`。`apps/auth` 可继续直接构造 `AuthService` 作为现有 HTTP App 的兼容
路径；DoorAgent 迁移及后续 Cordis Consumer 只能注入 `ctx.auth`，不得导入 PostgreSQL Store
或调用 App 内部对象。

Provider 装载顺序固定为：解析 `ctx.credentials` 中的数据库凭证引用 → 建立连接 → 运行 Auth
migration → 检查 active guard → `ctx.provide("auth", capability)`。连接关闭通过
`ctx.effect()` 注册；dispose 发生在异步初始化期间时不得 provide，须关闭已创建连接。数据库
凭证引用变化只记录脱敏重启告警，不热换连接，避免半可用实例。

用户、密码凭证、Feishu identity、外部迁移映射和强制审计行必须在同一数据库事务内提交；
任一唯一性、审计或中断失败都回滚整个用户导入。迁移路径不得复用当前会吞掉审计异常的
普通请求辅助方法。外部映射唯一键为 `(sourceSystem, sourceType, sourceId)`，既有映射的
`sourceDigest` 不一致时拒绝覆盖。资源 claim 同样以“归属映射 + 审计”为单事务，冲突时
fail closed。

用户导入事务本身不通过 upsert 覆盖既有密码。DoorAgent 最终迁移可在原 complete run 上调用
独立 `sync-credential` 操作，把 create/merge 目标统一同步为源密码。该操作必须校验原 user
mapping、目标角色/模式/状态和独立一次性批准；真正改密前写加密 rollback snapshot，改密后撤销
该用户旧 session。operator 与 target 相同时只允许当前密码已等价的无写入确认，任何实际 self-sync
仍返回 `CREDENTIAL_STATE_CONFLICT`。当前密码已等价时不得创建 snapshot、重复写密码或撤销 session。
当前 DoorAgent 源没有可验证的 Feishu identity，因此 `AuthUserImportCandidate` 不接受 identity；
用户迁移后只通过 MewClaw `/login` 重新绑定。

并发写必须先按 source 三元组和目标唯一键取得数据库事务锁；相同 source/digest 的并发 apply
返回一次创建和其余 replay，不把唯一约束异常暴露为结果。每次持久化步骤之间及 COMMIT 前
重新检查 `AbortSignal`，取消时回滚全部临时写入。

`rollbackImport` 只接受 `sourceType=manifest` 且 operation 为 `rollback-run` 的专用批准。在
cutover delta 能证明目标自迁移后没有产生业务写入之前，Provider 必须返回
`ROLLBACK_GUARD_UNAVAILABLE` 并保留全部对象，禁止依赖 `createdTarget` 级联删除用户或资源。
`reconcileImport` 除映射摘要外还必须确认目标用户/资源仍存在且资源归属一致。当 source 为
`manifest` 时，Provider 必须按 `runId + planId + sourceSystem` 聚合该次迁移的全部映射；其他
source 类型保持单映射核验语义。

`authorizeImportRun` 同时接收不可变计划预分配的脱敏 action manifest：每项只允许稳定
`actionId`、连续 `sequence`、operation、source 与 payload digest，不得包含邮箱、密码、路径或
业务内容。Auth 必须在消费 `apply-run` 批准的同一 PostgreSQL 事务中持久化 run 和全部 action；
Migration 只能通过 `AuthCapability` 领取 action，不得直接读写 Auth 表。领取使用只落盘摘要的
随机 lease token，过期 action 可由重启后的 Consumer 重新领取。

已登记 run 的 `applyUserImport` / `claimResource` 必须携带与 source、operation、payload digest、
Scope、snapshot 和 cutover epoch 全部匹配的 action lease；缺失、过期或跨 run 的 lease 均
fail closed。mapping、强制 audit、action completion 与脱敏 result outbox 必须在同一事务提交；
失败时整体回滚。result outbox 采用 lease + ack 的 at-least-once 语义，`eventId`、业务事务内生成的
`occurredAt` 与 plan 预分配 `sequence` 在重试中保持稳定，未 ack 或租约过期可重投。Consumer
必须在 Cordis 事件投递成功后才 ack；若 ack 已提交但本地 checkpoint 未落盘，必须通过
`listImportOutboxReceipts({ afterSequence, limit })` 读取 `acknowledgedAt` 非空的 durable receipt，
校验不可变 event/result binding 后推进 checkpoint。manifest reconcile 以登记 action 为
期望集合：没有 durable run 时至少报告一个 missing，pending action 计 missing，跨 run mapping
计 mismatched，不能把空 mapping 集误判为成功。

迁移凭证复用白名单只有两个严格 profile，不接受任意 salt/key 长度：

- `dsh-native`：`scrypt$16384$8$1$<salt>$<key>`；salt 解码后严格 16 bytes、key 严格
  32 bytes，两段均为无 `=` 填充的 canonical base64url，解码再编码必须完全一致。
- `dooragent-scrypt-v1`：仅当 `sourceSystem === "dooragent"` 时接受原始
  `scrypt:<32 lowercase hex>:<128 lowercase hex>`。32 个 hex 字符必须作为 32-byte ASCII
  salt 原样参与 scrypt，128 个 hex 字符解码为 64-byte derived key；转换器固定输出
  `scrypt$16384$8$1$<base64url(ASCII salt)>$<base64url(derived bytes)>`。不得把 salt hex 解码成
  16 bytes，也不得向其他 sourceSystem 开放这个 profile。

算法、参数、字段数、字符集、大小写、长度或 canonical 检查任一不符都返回
`reset_required`，即使普通登录 verifier 能解析也不得导入复用。`inspectCredential` 的
`sourceSystem` 由受信迁移计划提供，不接受浏览器覆盖；原始或转换后的凭证不得进入日志、报告
或事件。

错误分类：无效 Scope/批准/计划属于调用方错误；身份、邮箱、资源归属或外部映射冲突是
可审计业务拒绝；数据库、migration、审计写入和连接故障属于环境故障；取消返回可重试的
中断结果。任何错误都不得携带密码编码、identity subject、连接串或凭证值。

## 3 邮箱流程

### 3.1 注册与验证

`POST /auth/register` 接受邮箱、密码、显示名；邮箱按 Unicode trim + lowercase 规范化，密码长度 12..256 字符。响应不泄露邮箱是否已存在；对新用户发送短期一次性 6 位数字验证码，测试使用 fake sender，生产使用 `dsh-mail-imap`/nodemailer 的 SMTP 凭证引用。未验证用户不能进入 Web API。对同一待验证账户重发时，旧验证码立即失效。

`POST /auth/verify` 接受邮箱、验证码和可选配对 token，消费绑定用户的摘要验证码，激活用户并创建会话；重复/错误/过期验证码统一返回通用失败码。旧的 `GET /auth/verify` 只返回迁移提示，不消费凭证，避免验证码进入 URL、历史记录和代理日志。

### 3.2 登录、退出与密码

`POST /auth/login` 使用 scrypt 校验，失败统一错误和按 IP+邮箱限流；连续失败触发短期锁定。成功创建滚动会话。`POST /auth/logout` 撤销当前会话并清除 Cookie。`GET /auth/me` 返回最小用户投影（不含凭证）。`POST /auth/password/change` 要求当前会话和旧密码；`POST /auth/password/forgot` 恒定响应；`POST /auth/password/reset` 消费一次性 token 并撤销该用户旧会话。

生产恢复只允许通过内部 `AuthService.recoverAdminAccount` 服务契约执行：调用方必须提供已在受信本地 DSH 侧取得的严格 `dsh-native` scrypt 编码；Auth 在一个数据库事务内把目标用户设为 `active/admin/full`、替换凭证并撤销其旧会话，其他用户不受影响。该入口不暴露给浏览器，不接受 DoorAgent 原始编码，服务层只写入凭证 profile、目标用户和撤销数量等脱敏审计字段。

## 4 Cookie、CSRF 与请求边界

- 会话 Cookie：`__Host-dsh_session`、`HttpOnly`、`Path=/`、`SameSite=Lax`，生产 `Secure`；不使用 localStorage 保存凭证。
- CSRF Cookie：非 HttpOnly 的随机值；所有改变状态的 `/auth/*` 请求和代理 RPC 必须带同值 `x-csrf-token`，并通过 Origin/Host allowlist。只允许配置的 authorities，拒绝缺失/跨站 Origin。
- `GET`/HEAD 静态资源和 OAuth callback 不要求 CSRF；OAuth callback 只接受已消费 state。
- 未认证：`/auth/*`、静态登录资源和不可枚举的 `/share/<id>/*` 公共分享可访问；官方 `/api/*`、DSH WebSocket、`/v1/*`、`/admin/*` 一律 401/403。分享路径在平台登录/CSRF 前分流，但浏览器 Cookie、Authorization、Scope 与身份头必须被清除，再由 Auth Edge 使用内部凭证代理到 loopback Preview App；健康检查只在 loopback 管理面使用内部令牌。
- 所有响应 `Cache-Control: no-store`（静态 hash 资源除外）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`；CORS 不开放通配符。

## 5 飞书快捷注册与绑定

- `/auth/feishu/start` 生成一次性 10 分钟 state 摘要，携带固定 redirect URI、随机 return path 和可选当前用户 ID。
- callback 通过官方 Feishu OAuth endpoint 换取 user access token，再调用官方用户信息接口；只保存 `open_id`/`union_id`，不保存 access token。
- 未登录：已有 identity 直接登录；新 identity 创建 `admin/full`（首个用户）或 `user/lightweight`。
- 已登录：只绑定到当前用户；若 identity 已属于其他用户则拒绝并审计。不会以未验证邮箱自动合并账户；邮箱匹配只作为提示，不作为授权证据。
- Feishu Gateway 的 `authorizedOpenIds`/群 allowlist 仍独立生效，Web 登录不改变机器人入口授权。

### 5.1 MewClaw `/login` 配对

这条链路不是 Feishu OAuth：飞书 MewClaw 收到 `/login` 后，仅通过 loopback auth-edge
内部端点签发短期一次性 token。Gateway 同时提交当前完整 Scope + generation 派生的
deterministic `sessionId`；token 只保存 `open_id`、sessionId、摘要和过期状态。浏览器消费
`/auth/pair` 后建立普通 Web session，并把该 session 登记到当前 Auth 用户的
`auth_resources`。因此 Web 能看到并续接这次 `/login` 所在对话；用户在其他飞书对话再次
发送 `/login` 会逐个补充自己的会话映射。

浏览器永远不能提交或改写 sessionId，配对端点只接受 loopback + 服务端凭证；已有其他用户
资源的 sessionId 发生冲突时 fail closed。配对不会修改 Feishu Scope、session header、cwd、
workspace 根或 Worker/OCI/lightweight 沙箱策略，只增加 Web 资源归属记录。

配对确认的唯一写入口是 `AuthStore.commitFeishuPairing`；不得恢复或旁路调用旧的
`consumeFeishuPairingToken`，也不得在 Service 中拆分多次 Store 写入。Provider 必须在同一个
原子提交中锁定并消费配对 token、创建或复用 Feishu identity、登记飞书 `sessionId` 对应的
`auth_resources` 归属，并创建浏览器 Web session。只有结果为 `paired` 时 token 才能被消费；
`failed`、`user-unavailable`、`identity-conflict`、`session-conflict` 等业务拒绝，以及任意持久化
异常，都必须回滚 identity、资源和 Web session 的临时写入，并保持 token 未消费且仅在原过期
时间内可重试。同一 token 的并发确认必须串行化为恰好一次 `paired`，其余请求返回通用失败，
不得创建重复 identity、资源归属或 Web session。

Web 消费配对链接按当前会话分流：已有有效 Web 会话只显示确认绑定；未登录浏览器显示“已有账户登录并绑定”与“注册并输入邮箱验证码”两条路径。配对注册遇到已激活邮箱返回 `ACCOUNT_EXISTS`，前端引导切换到登录；若邮箱对应的是待验证账户且密码匹配，则重新签发验证码，避免首次投递失败后进入死路。邮件投递失败统一返回 `MAIL_DELIVERY_FAILED`（503），不向客户端暴露 SMTP 细节。

内部 `POST /internal/pairing/start` 响应同时返回 `binding.status`（`bound` 或 `unbound`）；已绑定时只返回脱敏邮箱和显示名。Gateway 将该状态渲染到 `/login` 的持久交互卡片，明确告知当前飞书身份是否已有 Web 账户，不改变配对授权、Scope 或一次性 token 语义。

若当前 Web 会话与飞书 identity 的既有归属不一致，确认接口继续 fail closed；配对页提供“切换到已绑定 Web 账户”恢复入口。该入口只允许 identity 所属账户通过邮箱密码登录后接续配对，不覆盖 identity、不删除原账户，也不改变 Scope、工作区或沙箱策略。

### 5.2 Web 账户界面

账户入口复用官方 `settings.trigger` slot，位于原设置按钮的位置，显示用户头像首字母和
“设置”；账户信息统一进入官方 `settings.section` 的“账户中心”，不向通用设置追加账户卡片，
也不新增独立的 Web 设置页。该注册遵守 Cordis
单 slot 优先级规则：仅以 `priority: -1` 覆盖官方设置触发器 `priority: 0`，不会重复挂载
footer action。

旧 `/auth/account` 页面已移除；历史 URL（包括 `section=feishu`）只返回带 CSRF cookie 的
同源重定向到 `/`，由官方 dsh Web 设置面板承载账户中心。密码、飞书绑定、用量和退出登录
均复用 Web client 的 `settings.section`，不改变任何权限、Scope、Worker 凭证或沙箱边界。

### 5.3 飞书绑定管理 API

绑定管理继续由 Auth Edge 承担，所有接口同源认证且不把身份映射当作登录凭证返回：

- `GET /auth/identities`：当前用户的绑定列表。
- `DELETE /auth/identities`：解绑当前用户的指定绑定，请求体为 `{ provider: "feishu", subject }`。
- `GET /auth/admin/identities`：管理员查看所有绑定及其用户公开资料。
- `DELETE /auth/admin/identities`：管理员解绑指定用户的绑定，请求体为 `{ userId, provider: "feishu", subject }`。

GET 需要有效 Web 会话，DELETE 还需要 CSRF；管理员接口拒绝普通用户。解绑只删除
`auth_identities` 映射，不删除账户、会话、工作区、Scope、沙箱或 Feishu 应用授权。没有密码
且只剩一个 Feishu 绑定的账户返回 `IDENTITY_LAST_LOGIN_METHOD`；目标不存在返回
`IDENTITY_NOT_FOUND`。成功和拒绝动作均写入审计日志，身份 subject 在审计元数据中只保存摘要。

## 6 代理与官方 API 保留

`POST /api/$events/result` 是新版 Remote Event 回传，携带 `payload.args.clientId/eventId/outcome`，
不是普通会话RPC。Auth通过同一用户的真实Remote mux下行握手及已投递waterfall记录关联，
回传仍要求登录、Origin/CSRF和实际agentId归属。只接受仍在当前连接中待回答的事件；取消、
逻辑流结束、断线及回答消费后清除记录，跨用户、未知事件或伪造业务流握手不能授权。
保留原始结果信封与上游outcome校验，不将选项结果重新当作用户提示词送安全审计。
回传失败会让官方Client主动结束generation并重连，必须验证选择成功后连接持续存活。

认证边界使用 Node `http`/`net` 反向代理转发官方静态资源、`/api/*` 和两个官方 WebSocket upgrade 路径；不重写官方 envelope。代理在转发前解析 JSON RPC envelope，仅重写/拒绝与资源归属和 preset 策略相关的 args；未知官方方法默认转发但必须有已认证会话，新增方法若涉及资源则 fail closed。

官方 `workspace/create` 的参数契约是 `payload.args.request.path`：descriptor 只声明
顶层参数 `request`，目录路径属于其内部字段。Auth Edge 必须校验实际转发的
`request.path`，普通用户按 `realpath`/symlink 规则限制在自己的工作区根内；管理员沿用
任意本机目录策略。转发不得向 `args` 顶层注入 `path`，也不能以默认根目录的检查代替
对嵌套目标路径的检查，否则会触发 `gateway/arguments-invalid` 或漏检目标目录。

`/share/<id>/*` 是独立公共数据面，不进入官方 RPC envelope。它支持 HTTP/API、SSE 与
WebSocket，拒绝 `CONNECT`/`TRACE`，并只代理到固定 loopback Preview App；浏览器不能提供
upstream、宿主端口或内部认证头。未知、过期和已撤销 ID 统一返回 404，避免枚举状态。

两个官方下行 WebSocket 对管理员原样保留；普通用户的 auth-edge 会关闭压缩协商并解析上游文本帧，只转发拥有归属记录的 `sessionId`/`workspaceId`。工作区顺序、归档列表只保留用户资源，未知帧和 `host/remote-event` 丢弃，`stream/error` 仅返回通用 `internal` 错误以保留官方重连语义。分片/超限/带扩展的上游帧 fail closed；Worker 仍只接收服务端 token，不接收浏览器身份。

角色策略：

| 角色 | 允许 preset | 默认 preset | 工作区根 |
| --- | --- | --- | --- |
| admin | `lark-standard` + 官方 full/OCI roster | `lark-standard` | 默认 `.workspaces/auth/admin/<adminId>`；可使用本机任意路径 |
| user | `lark-lightweight` + 当前 Worker 暴露的系统 preset | `lark-lightweight` | `.workspaces/auth/users/<userId>` |

代理永不接受浏览器提供的 `agentPreset` 作为授权证据；`session.create` 缺省/非法 preset 由角色策略补齐或拒绝。代理不修改 Worker 的 preset 文件、overlay、sandbox provider 或飞书运行面。

## 7 配置与凭证

可校验配置至少包括：`listenHost`、`listenPort`、`workerBaseUrl`、`workerTokenEnv`、`adminBaseUrl`、`adminTokenEnv`、`databaseUrlEnv`、`credentialRollbackKeyEnv`、`credentialRollbackPath`、`approvalTtlMs`（60 秒至 60 分钟，默认 15 分钟）、`sessionCookieSecure`、`trustedOrigins`、`userWorkspaceRoot`、`adminWorkspaceRoot`、`feishu`（app id/secret/redirect URI 的凭证引用）、`mail`（SMTP provider/凭证引用）、请求体和限流上限。生产缺失凭证 fail loud；测试通过内存 store/fake mail/fake OAuth，不读 `.env`。

`credentialRollbackKeyEnv` 只能引用独立的 32-byte AES-256-GCM 密钥（hex 或 base64url），不得复用数据库 URL、Worker/Admin Token 或其他服务凭证。`credentialRollbackPath` 必须是专用绝对目录；Auth Provider 创建目录为 `0700`、文件为 `0600`，以临时文件加 fsync 和原子链接方式落盘。回滚载荷全量加密，文件名仅为 `snapshotRef` 摘要；缺失、无效或与数据库凭证引用相同的配置在建立数据库连接前 fail loud。Provider dispose 时清零内存密钥并关闭持久化资源。

凭证迁移验收窗口内必须冻结 `credentialRollbackKeyEnv` 指向的密钥；旧 snapshot 尚未按 manifest
确认退役前禁止轮换。清理全部旧 snapshot 并完成恢复证据后才可生成新 key 并重启服务。

## 8 测试契约

- 密码：scrypt 随机盐、恒定时间比较、弱密码拒绝、错误信息不泄露账户存在性。
- 会话：HttpOnly/SameSite/Secure、滚动过期、撤销、重置密码撤销旧会话、token 只存摘要。
- CSRF/Origin/Host：跨站 POST、缺失/错误 token、伪造 Host、未认证 `/api` 与 WebSocket 全拒绝。
- OAuth：state 一次性/过期/绑定用户、identity 冲突、未验证邮箱不自动合并、token 不落盘。
- 飞书配对原子性：分别在 token 消费、identity、飞书 session 资源与 Web session 持久化点注入故障，断言全部写入回滚且 token 仍可在有效期内重试；identity/session 归属冲突不得消费 token；同一 token 并发确认恰好一次成功且只生成一个 Web session，内存与 PostgreSQL Provider 结果一致。
- 资源：用户 A 不能读取/提示/取消/删除用户 B 的 session/workspace；`session.list`/`workspace.list` 过滤；普通用户可选择当前 Worker 暴露的系统 preset，但不能越过自己的根目录、加载用户 preset 根或写入管理员配置；管理员策略可审计。
- 工作区创建契约：使用真实 `workspace/create` 与嵌套 `args.request.path` 重放普通用户根内目录、根外目录、符号链接越界及管理员目录；合法请求不得新增顶层 `path`，越界请求必须在代理转发前拒绝。
- 迁移能力：`dsh-native` 与 DoorAgent 专属 scrypt v1 合成向量的正确/错误密码验证、参数/长度/大小写/canonical 拒绝矩阵；显式角色映射不得触发首用户自动管理员逻辑；邮箱 merge 不覆盖既有密码；DoorAgent identity 输入 fail closed。
- 管理员恢复：非 `dsh-native` 凭证拒绝且不改变账户；恢复事务同时更新 `admin/full/active`、凭证和旧会话撤销，其他账户保留并产生脱敏审计。
- 原子性：凭证、外部映射或强制审计任一步失败时用户写入全部回滚；相同 source 摘要并发重放幂等，不同摘要 fail closed；事务中途取消在 COMMIT 前回滚。
- 批准与回滚：typed 签发由 Auth 生成 canonical payload digest；`apply-run` 逐项绑定 plan/run/Scope/operation/snapshot/cutover/source；批准单次原子消费、跨操作复用和 revoke/apply 竞态均拒绝；无 delta guard 时 rollback 保留全部对象并返回 `ROLLBACK_GUARD_UNAVAILABLE`。
- 凭证回滚存储：正确密钥可跨重启解密，错误密钥、篡改密文、snapshotRef 冲突和已关闭 Provider 均 fail closed；回滚文件不得出现原凭证、用户标识或 token，POSIX 权限必须为目录 `0700`、文件 `0600`。
- 凭证补同步：create/merge mapping 均须绑定原 run；当前密码等价时零 snapshot、零密码写入、零 session 撤销；改密成功但迁移 checkpoint 未写入时，新批准重试可幂等收敛。
- 对账：映射存在但目标用户缺失、资源缺失或资源 owner 改变时返回 mismatch。
- 生命周期：dispose 与异步初始化竞态不 provide 且连接关闭；迁移 Consumer 缺失 `ctx.auth` 时不激活，`apps/auth` 直接构造兼容测试继续通过。
- 隔离回归：`tests/composition.test.ts`、OCI provider、lightweight overlay、Gateway allowlist 和 session-directory 原有测试继续通过。
- E2E：fake worker + fake mail + fake Feishu OAuth 完成注册→验证→登录→创建会话→刷新→登出；不调用真实模型、飞书、邮件或外部服务。

## 9 行为变化

- 新版 `agentPresets/select` 映射到会话预设选择策略：普通用户仅可对实际 `agentId` 所属的本人会话选择白名单预设；缺失参数、他人会话或非法预设拒绝。保留原始 Remote 参数，不开放预设编辑、复制或删除能力。

此前官方 Web 仅适用于 loopback、没有产品登录层；启用 auth-edge 后，浏览器入口改为认证代理，Worker/Admin 仍 loopback。历史匿名 Web session 不自动归属于新用户；管理员可通过显式迁移/审计命令接管，默认不向普通用户暴露。Feishu `/login` 是显式用户操作，只映射发起该命令的当前 deterministic session，不构成按 sessionId 的通用迁移入口。

工作区创建按当前官方 `workspace/create` 的嵌套参数契约授权与转发，恢复合法目录的创建，
并对实际 `request.path` 执行用户目录边界校验；不改变管理员目录权限或既有资源归属策略。
