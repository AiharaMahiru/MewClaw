# DSH Linux 生产 Runtime SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-linux-production-runtime` + 既有 DSH Apps |
| 位置 | `infra/linux`、`apps/auth`、`apps/lark-worker`、`apps/lark-gateway`、`apps/admin` |
| 角色 | Deployment Combination + External PostgreSQL Provider + App Lifecycle |
| 里程碑 | M8 |
| 状态 | implementing（2026-08-24 全文评审 accepted 后进入本地实现） |
| 关联 ADR | ADR-3、ADR-6、ADR-8；[dooragent-migration.md](dooragent-migration.md) |
| 依赖能力 | DSH Apps、`dsh-sandbox-oci`、PostgreSQL wire protocol、systemd、Nginx |
| 提供能力 | Debian 生产运行底座；不新增 Cordis service key |

## 1 目的与边界

本部署组合在 Debian VPS 上为 DSH 提供可验证、可回滚的生产运行底座。它把代码发布、
PostgreSQL + pgvector、rootless Podman、systemd 生命周期、loopback 端口、Nginx 切流、
快照恢复和配置文件权限收敛为单一契约；应用能力仍由既有 DSH/Cordis 插件提供。

能力缝边界：

- Definition：本 SPEC、不可变 manifest schema、健康与回滚状态机；
- Provider：Debian PostgreSQL、pgvector、systemd、rootless Podman、Nginx 和文件系统；
- Consumer：Auth Edge、Worker、Gateway、Admin 与一次性迁移插件；
- 外部进程管理不伪装成 Cordis 插件；进入应用进程后的注册仍遵守 `ctx.effect()`、
  `ctx.on()` 和 disposer 生命周期。

非目标：

- 不修改 `@deepseek-ai/dsh-*` 框架源码，也不把 DoorAgent Runtime 带入 DSH；
- 不复用 DoorAgent 的 root 进程、登录 session cgroup、SQLite schema 或 Web 组件；
- 不把 Docker 当作 `dsh-sandbox-oci` 的无验证替代；
- 不让 Nginx、浏览器或 Gateway 直接访问 Worker/Admin 内部凭证；
- 不在此 SPEC 中实现用户 ETL、业务 schema 或模型工具；
- 不改变 Windows 本地开发的便携 PostgreSQL 和 supervisor 路径。

依赖预算：不新增 npm 运行时依赖。manifest、摘要、原子文件切换和状态机使用 Node 标准库与
仓库既有能力；PostgreSQL、pgvector、systemd、Podman 和 Nginx 是目标主机的外部 Provider，
通过版本、签名或 digest 锁定。任何新增部署库必须先证明标准库和现有 DSH 能力不能胜任。

## 2 服务契约

本组合不声明 Cordis service key。稳定面由 manifest、操作状态和既有健康端点组成。
`infra/linux` 实现以下可序列化契约；所有 JSON 输入均在 wire 边界校验。

```ts
type RuntimePhase =
  | "staged"
  | "verified"
  | "source-frozen"
  | "promoted"
  | "rollback-pending"
  | "rolled-back"
  | "accepted"

interface ProductionRuntimeManifest {
  schemaVersion: 1
  createdAt: string
  host: { hostname: string; bootId: string; osRelease: string; architecture: string }
  release: {
    gitCommit: string
    lockfileSha256: string
    artifactSha256: string
    productionLockSha256: string
  }
  paths: RuntimePaths
  ports: RuntimePorts
  database: { version: string; vectorVersion: string; cluster: string; bindHost: "127.0.0.1" }
  sandbox: { rootless: true; imageDigest: string; network: "none" }
  units: readonly UnitManifest[]
  environment: {
    path: string
    bytes: number
    sha256: string
    owner: "dsh"
    group: "dsh"
    mode: "0600"
  }
}

interface CutoverEpochRecord {
  schemaVersion: 1
  epochId: string
  migrationRunId: string
  sourceManifestSha256: string
  targetManifestSha256: string
  openedAt: string
  sealedAt?: string
  phase: RuntimePhase
  nextSequence: number
}

interface CutoverDeltaEntry {
  epochId: string
  sequence: number
  operationId: string
  occurredAt: string
  surface: "auth" | "billing" | "session" | "workspace" | "upload" | "knowledge" | "memory"
  kind: "create" | "update" | "delete"
  targetDigest: string
  beforeDigest?: string
  afterDigest: string
  reversible: boolean
  durableReference: string
}
```

`durableReference` 只能指向 DSH 审计记录、账本记录、session event 或摘要 manifest，
不能嵌入消息正文、文件内容、邮箱、token、绝对工作区路径或密钥。

稳定操作：

1. `inspect`：只读核对主机、端口、依赖、权限和现存服务；
2. `stage`：写入新的不可变 release，不改变 `/opt/dsh/current`；
3. `verify`：运行 build、健康、隔离、备份恢复和 manifest 摘要检查；
4. `open-epoch`：绑定源/目标 manifest 与迁移 `runId`，开始增量日志；
5. `promote`：原子切换 release 指针和 Nginx upstream；
6. `seal-epoch`：停止接收新写入并固定 delta 摘要；
7. `rollback`：按 §6 状态机回切，非空 delta 不得自动恢复 DoorAgent 可写；
8. `accept`：验收通过后关闭回滚窗口，但不立即删除 DoorAgent 快照。

错误分类：

- `HOST_UNSUPPORTED`：OS、架构或内核能力不满足，属于环境故障；
- `PORT_CONFLICT`：内部端口已占用，属于部署配置错误；
- `PACKAGE_LOCK_MISMATCH`：APT candidate 或包摘要与 `production.lock.json` 不一致，禁止 stage；
- `RELEASE_DIGEST_MISMATCH`：release 与 manifest 不一致，必须重新 stage；
- `DATABASE_NOT_READY` / `VECTOR_EXTENSION_MISSING`：数据库 Provider 不满足契约；
- `ROOTLESS_OCI_UNAVAILABLE`：Podman、subuid/subgid 或镜像不可用，必须 fail closed；
- `ENV_DIGEST_MISMATCH` / `ENV_PERMISSION_INVALID`：环境文件传输或权限失败；
- `SNAPSHOT_UNRESTORABLE`：备份无法在隔离目标恢复，禁止切流；
- `NGINX_VALIDATION_FAILED`：候选配置未通过语法或回源检查；
- `HEALTHCHECK_FAILED`：任一 App 或依赖未就绪；
- `CUTOVER_DELTA_GAP`：增量序号不连续或 durable reference 不可解析；
- `ROLLBACK_RECONCILE_REQUIRED`：epoch 存在业务写入，禁止盲目恢复旧系统可写。

## 3 配置契约

```ts
interface RuntimePaths {
  releasesRoot: string
  currentLink: string
  stateRoot: string
  workspacesRoot: string
  uploadsRoot: string
  sessionsRoot: string
  backupsRoot: string
  environmentFile: string
}

interface RuntimePorts {
  authEdge: number
  workerWeb: number
  workerRun: number
  admin: number
  postgres: number
}

interface LinuxProductionConfig {
  serviceUser: string
  serviceGroup: string
  nodePath: string
  paths: RuntimePaths
  ports: RuntimePorts
  publicOrigin: string
  databaseUrlEnv: "DATABASE_URL"
  workerTokenEnv: "WORKER_TOKEN"
  adminTokenEnv: "ADMIN_TOKEN"
  pairingTokenEnv: "AUTH_PAIRING_TOKEN"
  podmanPath: string
  sandboxImageDigest: string
  nginxBinaryPath: string
  nginxConfigPath: string
  nginxVhostPath: string
  cutoverJournalPath: string
  backupRetention: { daily: number; weekly: number }
}
```

四个 App 的启动环境必须设置 `DSH_PROJECT_ENV_DIR=/var/lib/dsh`。App 仍通过
`loadLayeredEnv()` 建立官方冻结快照，不直接解析 `.env`；因此
`/var/lib/dsh/.env` 是 `project-env` 默认层，`$DSH_HOME/.credentials.yaml` 的受管值
可以覆盖它。Worker、Gateway、Admin 不得把整份 `runtime.secrets.env` 作为继承环境
注入，否则继承环境会反向压过 Models 页面写入的受管凭证。Auth Edge 不装载凭证
Provider，为校验内部控制面 token 保留该环境文件。

生产 manifest 必须显式配置全部字段，不使用开发默认值。校验规则：

- `serviceUser/serviceGroup` 必须是专用系统账户 `dsh`，无登录 shell，不属于 Docker 组；
- `releasesRoot=/opt/dsh/releases`，`currentLink=/opt/dsh/current`；release 目录只读；
- 状态根为 `/var/lib/dsh`，环境文件为 `/etc/dsh/dsh.env`；
- 七个端口均为互不相同的 `1..65535` 安全整数，所有内部服务只绑定 loopback；
- 生产端口为 `13080/13081/13082/13083/18788/18791/15432`，其中 `13082` 是独立
  Preview App，`13083` 是受控 Browser App；
  正式 stage 前必须重新检查，冲突即失败；
- `publicOrigin` 必须是生产 HTTPS Origin，并进入 Auth Edge trusted origins；
- `sandboxImageDigest` 必须使用 `sha256` digest，禁止 `latest` 和仅标签引用；
- token、数据库密码、SMTP、飞书和模型凭证仅以环境变量名出现；
- 生产 Nginx 路径必须来自当前 master 进程实测；当前锁定 binary 为
  `/www/server/nginx/sbin/nginx`、主配置为 `/www/server/nginx/conf/nginx.conf`、vhost 为
  `/www/server/panel/vhost/nginx/chat.rwr.ink.conf`，禁止回退到 `/etc/nginx` 假设；
- `backupRetention.daily >= 7`、`weekly >= 4`，删除前必须确认至少一个已验证恢复点。

生产包锁位于 `infra/linux/production.lock.json`。2026-08-24 在目标 Debian 13 `amd64` 主机上
只读查询后，结合宿主 no-upgrade 门禁锁定：PostgreSQL server/client `17.9-0+deb13u1`、
pgvector `0.8.0-1`、Podman
`5.4.2+ds1-2+b2`、uidmap `1:4.17.4-2`、slirp4netns `1.2.1-1.1` 和
fuse-overlayfs `1.14-1+b1`；Node runtime 锁定官方 `24.19.0` Linux x64 tarball、字节数与
SHA-256，满足仓库 `node >=24` 引擎门禁。APT 项同时锁定仓库、deb 路径、字节数与 SHA-256；普通镜像已移除的
PostgreSQL 17.9 server/client 还必须成对锁定 `archiveContentSha1` 与 exact Debian Snapshot `archiveUrl`，
URL 必须由该 content ID 派生，不得接受任意 fallback URL。stage 前重新查询 candidate 并验证包摘要，任何漂移返回
`PACKAGE_LOCK_MISMATCH`，不得静默改写锁文件。

端口 overlay 必须晚于基础 bundle 和 OCI overlay 应用：覆盖 Worker `lark-run.port`、
Gateway `lark-run-client.baseURL`、Admin `host-webserver.port` 与 `controlPlane.workerBaseUrl`；
Worker Web 端口由 app CLI 显式传入，Auth Edge 使用 `AUTH_PORT`、
`DSH_WEB_INTERNAL_URL` 和 `AUTH_ADMIN_URL`。不得修改基础 bundle 的生产无关默认值。

## 4 事件契约

部署事件是受限 ops audit JSONL，不是 session event，也不通过 Cordis 广播：

- `runtime/release-staged`：release 与 artifact 摘要；
- `runtime/health-verified`：检查项、结果、持续时间，不含响应正文；
- `runtime/cutover-opened`：epoch、runId 与双端 manifest 摘要；
- `runtime/cutover-delta`：`CutoverDeltaEntry`；
- `runtime/upstream-promoted`：Nginx before/after 摘要；
- `runtime/rollback-requested`：触发原因与 delta 数量；
- `runtime/rollback-completed`：恢复入口和未对账 delta；
- `runtime/cutover-accepted`：验收时间和最终摘要。

同一 epoch 内 `sequence` 严格递增；`operationId` 幂等。写入采用 append + fsync +
原子 checkpoint，解析遇到截断、乱序或重复冲突时 fail closed。各业务面只能引用既有持久审计：

| 面 | durable reference |
| --- | --- |
| Auth | `auth_audit_log` 记录摘要 |
| Billing | append-only ledger/idempotency key |
| Session | DSH session event offset + event digest |
| Workspace/Upload | epoch 文件 manifest 条目摘要 |
| Knowledge/Memory | Provider 审计或版本记录摘要 |

缺少 durable reference 的写操作在 epoch 期间不得开放；自动回滚只允许 delta 为空。

## 5 模型可见面

无。manifest、健康结果、环境文件摘要、cutover journal 和回滚状态均不进入模型上下文。
DSH 会话内容仍只由 session event 承载；运维日志不得复制模型输入、工具参数或输出正文。

## 6 行为契约

### 6.1 发布与服务账户

- release 以 Git commit + pnpm lockfile + Debian production lock + 品牌补丁 + build artifact 摘要唯一标识；
- closure/bootstrap 使用只绑定 rehearsal source manifest 的 `bootstrap-stage` approval；release stage 另用
  `release-stage` approval，必须同时绑定 source manifest、artifact、runtime manifest、release ID 和同名 run ID；
  两者都不授权 data apply、open-epoch、promote 或 cutover；
- `/opt/dsh/current` 只在候选 release 全部门禁通过后原子切换；
- Auth、Worker、Gateway、Admin 全部以 `User=dsh` 运行，禁止 root；
- systemd unit 使用固定 Node 绝对路径、`WorkingDirectory=/opt/dsh/current`、
  `EnvironmentFile=/etc/dsh/dsh.env`、有界停止超时和 `Restart=on-failure`；
- `ProtectSystem=strict`、`PrivateTmp=true`、`NoNewPrivileges=true`，只给状态根写权限；
- Worker 保持 `ProtectHome=true`，并把宿主 `/run/user/995` 精确 bind 到 namespace 内
  `/var/lib/dsh/rootless-runtime`；`XDG_RUNTIME_DIR` 与用户总线地址只指向该别名。
  bootstrap 必须预建 `dsh:dsh 0700` 目标目录。禁止直接使用会被 `ProtectHome`
  遮罩的 `/run/user/995`，也禁止暴露整个 `/run/user`；
- Gateway 不加载工具/agent，Admin 不加载 dsh-base，Worker 执行只走 OCI profile。

### 6.2 PostgreSQL + pgvector Provider

- 使用 production lock 固定的 PostgreSQL server/client `17.9-0+deb13u1` 与 pgvector `0.8.0-1`，
  包锁摘要进入 release manifest；
- 建立独立 `dsh` cluster/database/owner，不复用 `/www/server/pgsql` 或 DoorAgent 数据库；
- 只监听 `127.0.0.1:<postgres>`，`pg_hba.conf` 使用 SCRAM，公网 5432 不属于 DSH；
- 数据库 UTF-8、UTC，并验证 `CREATE EXTENSION vector` 和 `SELECT extversion`；
- Auth、Billing、Knowledge、Memory、Cron 继续通过各自既有 Provider/Store 消费
  `DATABASE_URL`，部署层不直接写业务表；
- schema migration 只由既有应用 Provider 执行，部署脚本只能验证版本和可恢复性。

Linux PostgreSQL 是外部协议 Provider，不新增 `ctx.postgres`。Windows `infra/postgres`
保留为本地开发运行器；其 `.exe` 生命周期不得进入 Debian unit。

### 6.3 Rootless Podman

- `dsh` 账户具备独立 subuid/subgid 范围，锁定 Podman `5.4.2+ds1-2+b2` 并必须报告 rootless；
- rootless 探活必须在与 Worker 相同的 systemd mount namespace、用户和 XDG runtime
  alias 中执行；宿主 namespace 单独运行 `podman info` 不能替代此门禁；
- 镜像以 `dsh` 用户构建/导入，生产 overlay 使用 digest；
- 不赋予 Docker socket、root Podman 或特权容器访问；
- 每 Scope 单挂载、容器内 UID 10001、默认 `network=none`、资源上限和清理语义
  继续以 [sandbox-oci.md](sandbox-oci.md) 为唯一业务契约；
- Podman、镜像或用户 namespace 任一失败时 Worker 会话失败，不降级到本机 full 执行。

### 6.4 Nginx 与切流

- 对外只开放 Nginx 80/443；Nginx 全站反代 Auth Edge，不直连 Worker/Admin；
- 当前 80/443 由宝塔 master 进程
  `/www/server/nginx/sbin/nginx -c /www/server/nginx/conf/nginx.conf` 托管；
  `systemctl nginx` inactive 不是代理停止或异常的证据，切流门禁不得依赖它；
- 当前 vhost `/www/server/panel/vhost/nginx/chat.rwr.ink.conf` 有两处
  `proxy_pass http://127.0.0.1:8787`；candidate 必须恰好同时替换两处，数量漂移即 fail closed；
- candidate 与不可覆盖的旧 vhost 备份都写在 live vhost 同目录，源、候选、备份 SHA-256
  逐项匹配冻结 manifest 后，才允许同文件系统原子 rename；
- commit 后先用实际 binary 执行 `-t -c /www/server/nginx/conf/nginx.conf`，并复核 master PID
  的命令行仍包含同一 binary/config；通过后仅向该 PID 发送 `HUP`，不调用 systemd reload；
- reload 失败立即恢复旧 vhost；DoorAgent 在验收期保持只读、可回切但不可与 DSH 双写。

### 6.5 快照、恢复与 cutoverEpoch

- SQLite 必须使用在线 backup API，并在冻结写入后 checkpoint；禁止只复制主文件；
- JSONL、工作区、上传和 Mem0 事实源分域生成数量、字节数和 SHA-256 manifest；Qdrant 只记录
  镜像、collection 所有权和快照状态，旧向量按关联数据 SPEC 丢弃，不作为 DSH 恢复输入；
- DSH PostgreSQL 使用 custom-format `pg_dump`，同时保存 schema/extension/role 清单；
- 每个备份集必须在隔离目录、隔离数据库名和隔离端口完成真实 restore；
- `open-epoch` 后所有 DSH 写入进入连续 delta 日志；DoorAgent 保持只读；
- delta 为空可原子回切并恢复 DoorAgent 写入；delta 非空时只能回到 DoorAgent 只读入口，
  状态转为 `rollback-pending`，完成对账/补偿后才允许任一系统恢复写入；
- 验收结束只关闭回滚窗口，不立即删除 DoorAgent 数据，保留期由批准记录决定。

失败模式：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 服务以 root 启动 | unit 启动拒绝 | 修正 User/Group 和目录所有权 |
| 内部端口冲突或绑定公网 | verify 失败 | 调整生产 overlay，重新生成 manifest |
| PostgreSQL/pgvector 版本漂移 | 应用不启动 | 恢复锁定包或重建独立 cluster |
| Podman 非 rootless或镜像漂移 | OCI gate 失败 | 修复用户 namespace，重新导入 digest |
| `.env` 摘要或权限不符 | 所有 App 保持停止 | 重新受控传输并校验 |
| snapshot 无法恢复 | 禁止 open-epoch | 重做快照和恢复演练 |
| Nginx master/config 漂移或 reload 失败 | 不发信号或保留旧 upstream | 恢复同目录备份，重新核对 PID 并执行 `nginx -t -c` |
| App 健康失败 | 不切流或立即回切 | 保留日志摘要，修复后重新 stage |
| delta 序号缺口 | epoch fail closed | 停止写入并从 durable references 重建 |
| rollback 时 delta 非空 | 进入只读待对账 | reconcile 后重新 promote 或批准回切 |

## 7 安全与信任

- `.env` 只允许用户已授权的原文件字节传输；不得解析、打印或进入 Git/日志/证据；
- 传输记录只含源/目标路径、字节数、SHA-256、owner/group/mode；目标必须 `dsh:dsh 0600`；
- stage 文件同样 `0600`，摘要不一致时不得替换目标；失败 stage 必须受控清除；
- PostgreSQL、Worker、Preview、Admin、Auth 内部端口全部 loopback；现有公网 5432 必须单独完成依赖盘点后收敛，不能冒然影响其他业务；
- systemd unit 不接受 shell 拼接的用户输入，`ExecStart` 使用绝对路径和固定参数；
- rootless Podman 不共享宿主密钥环境、Docker socket或 root 存储；
- Nginx 回调和浏览器载荷不是切流/回滚批准证据；批准必须绑定 epoch、runId 和 manifest；
- ops audit 对 ID、路径和用户信息只保存摘要；日志不得包含 Cookie、Bearer、密码哈希或模型正文。

## 8 测试契约

- `unit`：manifest schema、端口唯一性、路径根、状态机、delta 序号和幂等键；
- `security`：五个 App 非 root、内部端口 loopback、环境权限、无 Docker socket、无本机执行降级；
- `security`：普通用户跨 Scope 工作区/会话/知识/记忆/计费全部拒绝；
- `integration`：PostgreSQL 17 + pgvector 版本、迁移并发、Auth/Billing/Knowledge/Memory/Cron 共库；
- `e2e`：rootless Podman 中等工程任务、默认断网、资源超限、中断和零残留容器；
- `e2e`：systemd 启停、SIGTERM 有序关闭、崩溃重启、主机重启恢复；
- `e2e`：Nginx WebSocket、登录/注册/退出、Admin、飞书 `/login` 配对与会话续接；
- `snapshot`：源/目标 manifest、`.env` 摘要/权限、镜像 digest、unit/vhost 摘要；
- `restore`：PostgreSQL、SQLite、JSONL、工作区、上传和 Mem0 可追溯事实在隔离目标真实恢复；
  Knowledge 原文与 ACL 在目标 PostgreSQL/pgvector 重新摄取，删除旧 Qdrant 向量后仍可重建检索；
- `rollback`：空 delta 自动回切；非空 delta 必须进入只读 `rollback-pending`；
- `chaos`：数据库不可用、Podman 不可用、磁盘满、Nginx reload 失败和网络中断均 fail closed；
- `production`：执行 `pnpm verify`、品牌补丁、production build、六个 preset 和真实浏览器/飞书功能矩阵。

关键验证入口包括 `systemd-analyze verify`、实际 master PID 命令行、
`/www/server/nginx/sbin/nginx -t -c /www/server/nginx/conf/nginx.conf`、`pg_isready`、
`SELECT extversion FROM pg_extension WHERE extname='vector'`、rootless `podman info`、
OCI E2E、HTTP 健康端点和恢复演练。任一关键验证缺证据时不得声明可切流。

## 9 迁移映射

| 来源 | Linux DSH 处置 |
| --- | --- |
| `infra/postgres` Windows 便携运行器 | 保留本地开发；生产改用 Debian PostgreSQL Provider |
| `infra/windows` supervisor | 不迁移；Linux 使用受限 systemd units |
| `infra/sandbox` 镜像 | 复用构建定义，生产引用镜像 digest |
| `apps/*` bins | 从不可变 release 启动，不复制 DoorAgent 启动脚本 |
| DoorAgent root/session 进程 | 淘汰；不作为 systemd 模板 |
| DoorAgent Nginx vhost | 仅保留 TLS/域名/WebSocket语义，upstream 原子切到 Auth Edge |
| DoorAgent PostgreSQL `/www/server/pgsql` | 不复用、不修改；DSH 建独立 cluster |
| DoorAgent SQLite/WAL | 在线快照后只作为迁移源 |
| DoorAgent Docker/Qdrant/Mem0 | 可追溯原文、ACL、关系与 provenance 按迁移 SPEC 转换并重新摄取；旧向量和 Docker Runtime 淘汰 |
| 本地 DSH `.env` | 按用户授权原字节传输，只记录摘要与权限 |

行为变化：Linux 生产不使用便携 Windows PG、不使用 root 进程、不将 full 本机执行作为
OCI 故障回退；对外入口从 DoorAgent Web 改为 Auth Edge，所有管理请求仍经认证边界。

## 10 开放问题

1. 现有公网 5432、8787/8788 和 8790–8794 的其他业务依赖需生成所有权 manifest 后再收敛；阻塞防火墙变更。
2. `chat.rwr.ink` 是否为最终生产 Origin 与切流窗口需用户批准；阻塞 Nginx promote。
3. cutoverEpoch 各业务面的 durable reference 覆盖率必须由 Provider 测试证明；未覆盖面保持只读，阻塞写流量。
4. DoorAgent 只读保留期和非空 delta 的人工补偿责任人需在切流批准中填写；阻塞最终 accept。
