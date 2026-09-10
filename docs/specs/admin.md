# dsh-lark-admin SPEC（管理面宿主插件 + admin-web）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-admin`（Plugin）+ `apps/admin-web`（前端）+ `dsh-lark-admin` bundle + `apps/admin`（bin） |
| 位置 | `packages/lark/admin/`、`packages/bundle/admin/`、`apps/admin-web/`、`apps/admin/` |
| 角色 | Plugin（管理 API + 静态面） |
| 里程碑 | M3 |
| 状态 | implementing |
| 关联 ADR | ADR-4（进程边界）/ ADR-8（知识） |
| 依赖能力 | `webServer`（@deepseek-ai/dsh-host-webserver 0.1.0-rc.6）、`knowledge`（dsh-knowledge）、`credentials` |
| 提供能力 | 管理 HTTP 面（`/api/admin/*` + `/admin/*` 静态） |

## 1 目的与边界

知识管理面：文档快照、摄入任务（上传/进度/错误）、生命周期操作（archive/restore/set_visibility/reindex）。Epic child 6 已按 [webui.md](webui.md) 增加 dashboard 优先的只读运行观察与 conversations 二级页；worker 端点仍只由 admin 服务端调用，绝不暴露给浏览器。机器人模板管理仍不在本包范围。

拓扑决策（行为变化，lark-claw 为独立 admin-api 进程直连 PG）：

- **独立 admin 进程**（`apps/admin` bin）：bundle 只含 credentials + host-webserver + knowledge-postgres + lark-admin——**不挂 dsh-base**，进程内无 agents/tools，物理上不可能执行工作区工具（硬边界强化）；
- 与 worker 共用同一 PG（不同连接池），知识数据面单源；
- 浏览器 Scope 仅在此创建：admin API 以配置的 admin 身份 Scope 调用 `ctx.knowledge`，走同一 ACL 谓词——**admin 不绕过查询 ACL**；
- 端口 8791（lark-claw admin-api 仍占 8790，迁移期并存；M5 交接）。

## 2 服务契约

插件不提供新服务键，只向 `webServer` 注册路由（register 返回 disposer，全部 ctx.effect 生命周期内注册）：

```
GET  /api/admin/knowledge                  → KnowledgeSnapshot（文档 + 汇总）
GET  /api/admin/knowledge/documents/:id    → KnowledgeDocument | 404
POST /api/admin/knowledge/documents/:id/action
      body { action: 'archive' | 'restore' | 'reindex' | 'set_visibility',
             visibility?: 'user_private' | 'bot_shared' }   → KnowledgeDocument | 404
GET  /api/admin/knowledge/uploads          → IngestionRun[]（limit 默认 8）
POST /api/admin/knowledge/uploads          → IngestionRun（原始字节体摄入，见 §3）
GET  /api/admin/knowledge/uploads/:id      → IngestionRun | 404
GET  /api/admin/healthz                    → { ok: true }（含 PG 探活）
GET  /api/admin/dashboard                  → AdminDashboardSnapshot（见 webui.md）
GET  /api/admin/control/conversations/:targetId?generation=<n>
                                            → AdminConversationSnapshot（见 webui.md）
GET  /api/admin/billing/summary             → 用量聚合（含 totalUsd）
GET  /api/admin/billing/quota?userId=<id>   → 用户自然月额度（USD）
PUT  /api/admin/billing/quota               → 修改用户额度（monthlyLimitUsd）
GET  /api/admin/billing/prices              → 模型价格（USD/百万 token）
PUT  /api/admin/billing/prices              → 修改模型价格（USD/百万 token）
GET  /admin/*                              → admin-web 静态面（SPA 回退 index.html）
```

错误信封统一 `{ error: code }`：400 INVALID_REQUEST（参数非法）、401 UNAUTHORIZED、404 NOT_FOUND、413 UPLOAD_TOO_LARGE、415 UNSUPPORTED_MIME、500 INTERNAL_ERROR。业务细节不进入响应体（与 lark-claw 一致）。

## 3 配置契约

```ts
interface Config {
  /** 管理身份：knowledge 调用的 Scope（tenant/bot/deployment/user），conversation 固定 'admin-console'。 */
  identity: { tenantId: string; botId: string; deploymentId: string; adminUserId: string }
  /** 摄入源根目录（绝对路径；必须与 knowledge Provider 的 uploadsRoot 一致）。 */
  uploadsRoot: string
  /** admin-web 静态目录（绝对路径，缺省 <cwd>/apps/admin-web/dist）。 */
  webRoot?: string
  /** 摄入单文件上限；缺省 100 MiB，安全整数范围 1..100 MiB。 */
  maxUploadBytes?: number
  /** admin Bearer 令牌凭证引用（env 变量名）；必填，缺失 fail loud。 */
  adminTokenEnv: string
  /** 摄入任务列表默认条数；缺省 8，安全整数范围 1..100。 */
  defaultRunLimit?: number
  /** 只读 worker 控制面；完整约束见 webui.md §3。 */
  controlPlane?: ControlPlaneConfig
}
```

`maxUploadBytes` 与 `defaultRunLimit` 在插件装载时解析：缺失使用上述默认值，零值、负值、小数或超出范围一律拒绝启动。`GET /api/admin/knowledge/uploads?limit=` 只接受 1..100 的十进制安全整数；非法或超限请求回落到已校验的默认值，不扩大 Provider 查询。鉴权语义：**恒需 Bearer 令牌**（`adminTokenEnv` 必填，缺失 fail loud）。Bearer 比较用 `timingSafeEqual`（恒定时间）；loopback 绑定是纵深防御而非鉴权替代（lark-claw 仅 loopback 无令牌——行为收紧）。

上传端点 wire 格式（自研零依赖设计，admin-web 是本面唯一客户端）：

- `POST /api/admin/knowledge/uploads?name=<utf8>&mime=<text/*>&visibility=<...>&category=<...>&tags=<json>`，body 为原始字节（Content-Type application/octet-stream），无 multipart；
- 落盘 `.uploads/<scopeKey>/<uuid>-<sanitized name>`（realpath 校验防逃逸）后调用 `ctx.knowledge.ingest`，返回 IngestionRun（异步进度经 GET 轮询）；
- 大小上限 413、MIME 白名单 415（fail loud，不静默接受）。

## 4 事件契约

不发布 session 事件（admin 面无会话）。加载失败、摄入失败等进进程日志（结构化日志 M5 统一）。

## 5 模型可见面

无。admin 进程不挂 dsh-base，模型面物理不存在。

## 6 行为契约

- 上传幂等性：同 scope 同摘要重复上传走 Provider 同摘要去重（返回既有文档）；
- 摄入异步：POST 返回即运行（queued），进度经 uploads/:id 轮询；进程重启后遗留 processing 任务被 recoverInterrupted 置 failed(SERVICE_RESTARTED)（Provider 行为）；
- 生命周期操作对非所有者返回 404（谓词无匹配行——不泄露存在性）；
- admin-web 静态面：SPA 回退 index.html；dist 缺失时 /admin/* 返回 404 + 构建提示（不崩溃）。

## 7 安全与信任

- 进程物理无工具执行面（不挂 dsh-base；组合校验测试锁死 bundle 行集）；
- admin 身份 Scope 是配置项——admin 走与普通用户相同的 ACL 谓词，跨 tenant/bot 数据绝不聚合返回；
- 上传文件名 sanitize（保留扩展名白名单字符），路径拼接经 realpath 校验；
- 令牌恒定时间比较；令牌值绝不出现在日志/错误/响应。

## 8 测试契约

- `unit`：路由鉴权（无令牌与错误令牌均为 401 / 缺失令牌凭证装载失败 / 恒定时间比较路径）；
- `unit`：上传与列表上限配置在装载期 fail loud；非法或超限查询 limit 不放大 Provider 查询；
- `unit`：上传 wire 校验（大小 413、MIME 415、tags JSON 非法 400）、文件名 sanitize、action 载荷校验；
- `unit`：非所有者生命周期 → 404；错误信封形状；
- `unit`：admin-web api 客户端 + 视图模型（列表分组、状态文案）；
- `e2e`：真 PG 摄入→快照→归档→恢复→检索不可见链路（M3 验收）。

## 9 迁移映射

行为变化（R-17 终态记录）：lark-claw admin-api 的 runs/conversations（含消息注入 + SSE）/automation/system/artifacts 下载**不迁移**。当前管理面包含 [webui.md](webui.md) 定义的只读 dashboard/conversations 投影，但该扩展不恢复消息注入、SSE、任意会话目录或运行控制。

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/admin-api/src/knowledge-admin.ts`（AdminKnowledgeCoordinator） | 语义并入 dsh-lark-admin 路由（upload → ingest → 轮询） |
| `apps/admin-api/src/server.ts`（Fastify + multipart + helmet） | 重写为 webServer 路由（去 fastify/multipart/helmet 依赖——webServer 已是 node:http，multipart 以原始字节体替代） |
| `apps/admin-web/src/pages/KnowledgePage.tsx` + 依赖组件 | 平移适配新端点；其余页面（Conversations/Runs/Automation/System/Overview）不迁移（对应能力面 M5 再议），导航占位 |
| `apps/admin-web` 技术栈（Vite + React + TS + 自研 UI） | 平移（依赖预算内：react/react-dom/vite 已有） |

行为变化：admin-api 独立进程（直连 PG + Fastify）→ admin 独立进程（webServer + knowledge 能力缝）；admin 不再直连 PG 表（只经 ctx.knowledge）；multipart 上传改原始字节体。

## 10 开放问题

1. admin 进程与 worker 进程的 PG 迁移并发 → 同一 schema_migrations 表 + EXCLUSIVE LOCK（infra 平移语义已保证）；知识迁移版本号前缀 `knowledge/` 与既有版本隔离；
2. admin-web 构建产物在仓库内的分发（开发 vite dev / 生产 dist 静态）→ M3 采用 dist 静态 + `pnpm --filter admin-web build` 门禁；发布通道 M5 统一；
3. admin 令牌与 worker 令牌关系 → 独立（ADMIN_TOKEN 必填；M3 交付时写入本地 .env 随机值，遵守密钥纪律）。
4. WebUI 控制面边界 → 已由 [webui.md](webui.md) 定义并由 Epic child 6 实现：admin 服务端使用受限 loopback worker proxy，浏览器只调用 `/api/admin/*`。
