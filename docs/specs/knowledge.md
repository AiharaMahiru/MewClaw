# dsh-knowledge SPEC（知识能力缝）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-knowledge`（Definition）+ `dsh-knowledge-postgres`（Provider）+ `dsh-tool-knowledge`（Consumer） |
| 位置 | `packages/knowledge/*` |
| 角色 | 能力缝（三角色齐全） |
| 里程碑 | M3 |
| 状态 | implementing |
| 关联 ADR | ADR-8 |
| 依赖能力 | `ctx.credentials`（SILICONFLOW_API_KEY 凭证引用）；`dsh-lark-postgres-runtime`（runMigrations）；嵌入客户端为 Provider 内部独立 HTTP 客户端（§10-1 已解决） |
| 提供能力 | `ctx.knowledge` |

## 1 目的与边界

私有（`user_private`）与共享（`bot_shared`）知识库：摄入事务、查询内 ACL 过滤、混合检索（词法 + 向量 + 可选重排）、引用、版本与生命周期管理。

非目标：跨租户/全局知识（明确拒绝）；检索排序算法细节（Provider 内部）；富格式文件解析器（pdf/docx/图片——uploads/vision SPEC 域，M3 后半）；模型侧自动检索策略（preset 行配置，M4）。

M3 切片边界：**摄入只接受文本类源**（text/markdown 白名单），富格式解析在 uploads SPEC 落地后接上同一 IngestInput 面。

## 2 服务契约

```ts
interface Knowledge {  // ctx.knowledge
  /** 检索：Scope 决定可见知识库集合；过滤在查询谓词内完成（§7）。 */
  retrieve(scope: Scope, query: string, opts?: RetrieveOptions): Promise<KnowledgeHit[]>
  /** 摄入：显式声明（用户明确要求入库）；异步事务，进度经 IngestionRun 审计。 */
  ingest(scope: Scope, input: IngestInput, visibility: 'user_private' | 'bot_shared'): Promise<IngestionRun>
  /** 管理面快照：本 scope 可见文档列表 + 汇总（admin 面一次性拉取）。 */
  snapshot(scope: Scope): Promise<KnowledgeSnapshot>
  /** 单文档详情（本 scope 可见才返回）。 */
  getDocument(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>
  /** 生命周期（仅所有者：created_by_user_id === scope.user）。 */
  archive(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>
  restore(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>
  moveVisibility(scope: Scope, docId: DocumentId, target: 'user_private' | 'bot_shared'): Promise<KnowledgeDocument | undefined>
  /** 重索引：从原始 scoped 源重建，force 跳过同摘要去重。 */
  reindex(scope: Scope, docId: DocumentId, opts: { force: boolean }): Promise<KnowledgeDocument | undefined>
  /** 摄入任务审计（管理面轮询进度/错误）。 */
  ingestionRuns(scope: Scope, limit?: number): Promise<IngestionRun[]>
}
```

关键类型：

```ts
interface IngestInput {
  /** 源文件绝对路径；Provider 校验存在、位于 uploadsRoot/<scopeKey>/ 内、大小 ≤ 上限。 */
  sourcePath: string
  /** 展示名。 */
  sourceName: string
  /** MIME；M3 白名单：text/plain、text/markdown、text/x-markdown、text/x-commonmark、
   *  text/html、text/css、text/csv、text/tab-separated-values、text/javascript、
   *  application/json、application/xml（其余拒绝）。 */
  sourceMime: string
  /** 文档键（同键新版本取代旧版本）；缺省 = sourceName。 */
  documentKey?: string
  /** 业务分类（admin 摄入用；缺省 general）。 */
  category?: KnowledgeCategory
  /** 标签（≤8 个）。 */
  tags?: string[]
}

interface KnowledgeHit {
  docId: DocumentId
  documentKey: string
  name: string
  version: number
  visibility: 'user_private' | 'bot_shared'
  chunk: number            // ordinal
  text: string             // 不可信证据
  score: number            // 仅诊断，非授权依据
  citation: KnowledgeCitation  // {source, snippet, score}（contracts 已声明）
}

interface RetrieveOptions {
  topK?: number          // 默认 5
  candidateCount?: number // 默认 20
  rerank?: boolean        // 默认 true
}

interface IngestionRun {
  runId: string
  visibility: 'user_private' | 'bot_shared'
  fileName: string
  mimeType: string
  sourceSize: number
  category: KnowledgeCategory
  tags: string[]
  stage: 'queued' | 'inspecting' | 'extracting' | 'chunking' | 'embedding' | 'indexing' | 'completed' | 'failed'
  progress: number        // 0..100
  status: 'processing' | 'completed' | 'failed'
  documentId: DocumentId | null
  errorCode: string | null
  createdAt: string       // ISO
  updatedAt: string
  completedAt: string | null
}

interface KnowledgeDocument {
  docId: DocumentId
  baseId: string          // 库 id（tenant+bot+deployment+visibility+owner 派生）
  documentKey: string
  name: string
  mimeType: string
  size: number
  sha256: string
  visibility: 'user_private' | 'bot_shared'
  status: 'processing' | 'active' | 'superseded' | 'failed' | 'deleted'
  version: number
  chunkCount: number
  category: KnowledgeCategory
  tags: string[]
  createdAt: string
  activatedAt: string | null
  canManage: boolean      // 当前 scope.user 是所有者
}

interface KnowledgeSnapshot {
  documents: KnowledgeDocument[]   // 时间倒序，上限 500
  summary: {
    totalVersions: number
    activeDocuments: number
    privateDocuments: number
    sharedDocuments: number
    archivedDocuments: number
    totalChunks: number
    totalBytes: number
  }
}

type KnowledgeCategory = 'general' | 'product_manual' | 'technical_spec'
  | 'project_document' | 'policy_process' | 'faq'
```

所有权与可见性不变量（继承 lark-claw，语义逐条平移）：

- 库 id = SHA-256(tenant ‖ bot ‖ deployment ‖ visibility ‖ owner) 前 32 hex 的 UUID 格式派生；`user_private` 的 owner = scope.user，`bot_shared` 的 owner 为空；
- `bot_shared` 文档可被同 tenant+bot+deployment 的任意用户检索（摄入时自动写 ACL 行 `(deployment, deploymentId)`），生命周期操作仅 `created_by_user_id === scope.user` 的用户可用；`user_private` 仅 owner 可见可管；
- `docId` 永非所有权证据，一切操作按 Scope 复核（SQL 谓词内完成）。

## 3 配置契约

```ts
// dsh-knowledge-postgres Config
interface Config {
  /** 数据库连接串凭证引用（env 变量名）。 */
  databaseUrlEnv: string
  /** SiliconFlow API Key 凭证引用（env 变量名；嵌入与重排共用）。 */
  siliconflowApiKeyEnv: string
  /** 嵌入 API base URL（默认 https://api.siliconflow.cn/v1）。 */
  siliconflowBaseUrl?: string
  /** 嵌入模型（默认 Qwen/Qwen3-VL-Embedding-8B；维度 1024 与 schema vector(1024) 对齐）。 */
  embeddingModel?: string
  /** 重排模型（默认 Qwen/Qwen3-VL-Reranker-8B）。 */
  rerankModel?: string
  /** 分块参数（默认 4000 字符 / 400 重叠；maxCharacters 为 1..100000，overlap 为 0..maxCharacters-1）。 */
  chunking?: { maxCharacters: number; overlapCharacters: number }
  /** 检索默认（topK 5，范围 1..20；candidate 20，范围 1..100；rerank true）与摄入并发（默认 2，范围 1..8）。 */
  retrieval?: { topK: number; candidateCount: number; rerank: boolean }
  ingestionConcurrency?: number
  /** 摄入源根目录（绝对路径；sourcePath 必须位于其 <scopeKey>/ 内）。 */
  uploadsRoot: string
  /** 单文件大小上限（字节，默认 100 MiB，范围 1 byte..100 MiB）。 */
  maxSourceBytes?: number
}
// dsh-tool-knowledge（工具名固定 knowledge_search）
interface ToolKnowledgeConfig {
  enabled?: boolean                 // 默认 true
  topK?: number                     // 默认 5，范围 1..20
  candidateCount?: number           // 默认 20，范围 1..100
  rerank?: boolean                  // 默认 true
  timeoutMs?: number                // 默认 60000，范围 1000..300000 ms
}
```

所有上述数值仅在字段为 `undefined` 时使用默认值；Cordis/Schemastery 生成的空 `chunking` 对象等价于两个字段都缺省。`0`、负数、小数、不安全整数或越界值必须在知识 Provider 解析凭证前、模型工具写入系统提示/注册前 fail loud。`overlapCharacters: 0` 是合法的无重叠配置。`KnowledgePipeline` 的直接构造和每次 `retrieve()` 传入的 `topK` / `candidateCount` 复用同一范围约束，不能绕过装载期配置。

## 4 事件契约

发布：`lark/knowledge/citations`（contracts 已声明；payload `{scope, citations: KnowledgeCitation[]}`，来源节选非全文）。
消费：无（`lark/message/in` 附件驱动摄入留待 uploads SPEC 域，M3 后半）。

## 5 模型可见面

工具 `knowledge_search`（dsh-tool-knowledge 注册，`ctx.tools.register`）：

- 参数：`query: string`（模型只写查询文本；tenant/bot/deployment/user 一律来自运行信封 Scope）；
- Scope 解析：`exec.agent` → `ctx.larkScopeIndex.get(agent.id)`；查不到（非 lark 运行）fail loud 工具错误——检索拒绝在无 Scope 下执行；
- 返回：§2 `KnowledgeHit[]`（标为不可信证据）；有命中时经 `exec.agent.session.append("lark/knowledge/citations", …)` 落盘（模型可见 ⟺ 已落盘），网关卡片按事件渲染引用行；无命中不写引用事件；
- 无结果 = 空列表（非错误）；嵌入服务不可用时工具错误（不静默降级为纯词法——M3 禁用降级路径，见 §6 失败表）。

## 6 行为契约

摄入事务（顺序不可变，与 lark-claw 相同）：

1. 创建 IngestionRun（queued）并启动异步管线；
2. 读源（文本白名单校验、大小上限、SHA-256、路径归属校验）；
3. 分块（4000/400，`chunkDocument` 平移）；
4. 生成向量（批量 8，服务端重试 429/503/504）；
5. **单事务激活**：锁定库行 → 文档键所有权断言 → 同摘要去重（同 source_sha256 + 同 chunk digest 且 active 时直接返回既有 id）→ version+1 → 插入 processing 文档 → 插入 chunks → 旧 active 置 superseded → 新文档置 active；
6. 进度与结局写回 IngestionRun（completed/failed + errorCode）。

失败任一步 → 前一激活版本原样保留；删除（archive）先置 deleted（检索谓词即时排除）、异步清派生数据留待 M5 保留策略。启动时 `recoverInterrupted` 把遗留 processing 任务置 failed(SERVICE_RESTARTED)。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 摄入中途失败 | 旧版本激活；IngestionRun failed + errorCode | 重试/重索引 |
| 同源同摘要重复摄入 | 幂等：返回既有 active docId，不产生新版本 | — |
| 检索无结果 | 空列表（非错误） | — |
| 嵌入服务不可用 | 摄入 fail loud(EMBEDDING_FAILED)；检索工具错误（M3 无纯词法降级） | 环境修复 |
| ACL 外内容命中（测试场景） | 永不返回（查询谓词保证） | — |
| 非所有者生命周期操作 | 返回 undefined（SQL 谓词无匹配行），不报错 | — |
| MIME 非文本白名单 | 摄入任务 failed(UNSUPPORTED_MIME) | uploads SPEC 落地后扩展 |
| 源名称空白 | 摄入任务 failed(INVALID_SOURCE) | 修正后重传 |

## 7 安全与信任

- **ACL 过滤在查询内**（词法/向量/汇总/生命周期四个分支同一谓词）：tenant/bot/deployment/owner/ACL/status 全部谓词化；先取后滤禁止；`MANAGEABLE` 谓词额外要求 created_by_user_id = scope.user；
- 检索结果为不可信证据（提示注入面）：注入前标记、引用带来源与版本；
- 浏览器/外部 Scope 不接受（仅 admin API 以配置的 admin 身份 Scope 调用；admin 不绕过查询 ACL——admin 以配置身份走同一谓词）；
- 提示注入文本不得改变能力或检索 scope（工具参数只有 query）；
- 源路径归属：sourcePath 必须位于 uploadsRoot/<scopeKey>/ 内（realpath 校验，防逃逸）。
- SiliconFlow 嵌入/重排 JSON 响应在解析前限制为 1 MiB（声明长度与实际流字节均校验）；错误详情最多 512 字符、trace ID 最多 128 字符，防止异常上游放大 Worker 内存或日志。
- 嵌入响应的 index 必须完整且唯一地覆盖本批次，向量长度必须等于请求 dimensions；重排 index 必须是输入 documents 范围内的唯一安全整数，score 必须有限。

## 8 测试契约

- `security`：用户 A 不可检索用户 B 私有；跨 bot / 跨租户拒绝；词法/向量两分支 ACL 一致性；archive 后不可检索；非所有者 archive/restore/moveVisibility 无效果；
- `unit`：摄入事务原子性、失败回滚（激活前抛错 → 旧版本 active）、同摘要幂等、删除先不可检索、stale/superseded 版本不返回、moveVisibility 跨库重版本化、注入文本不改检索 scope；
- `unit`：嵌入客户端 wire 校验（1 MiB 响应预算、响应形状/批次顺序/向量维度/重排 index、密钥不出现在错误信息）、重试状态集合；
- `e2e`：真实摄入→检索→引用链路（M3 验收，真 PostgreSQL + pgvector，无密钥可重放：嵌入客户端注入 mock）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/rag/migrations/001/002/003*.sql` | 平移（表结构不变，字段名逐列保留；schema_migrations 版本号改 `knowledge/001` 前缀避免与既有库冲突） |
| `postgres-knowledge-store.ts` / `knowledge-search-sql.ts` / `knowledge-identifiers.ts` | 核心逻辑进 Provider（Scope 字段名 tenant→tenant 等平移；RunAttachment 换为 IngestInput 源描述） |
| `knowledge-ingestion-service.ts` / `knowledge-admin-service.ts` | Provider 内部（IngestionRun / snapshot / 生命周期） |
| `chunker.ts` / `siliconflow-client.ts` | 平移（zod wire 校验换手写边界校验——本仓库无 zod，规则 7 允许 wire 边界手写） |
| `file-extractor` / `visual-analysis` / `vision-client` / `cdg-file-bridge` | 留在 uploads/vision/cdg SPEC 域（M3 后半） |
| `apps/admin-api` knowledge 路由 | 重写为 dsh-lark-admin 插件（见 admin.md SPEC） |

行为变化（SPEC §9 显式记录）：

1. SiliconFlow 客户端由「嵌入路由」改为 Provider 内置独立 HTTP 客户端（dsh llm 能力无 embedding 接口，实证见 docs/evidence/m3-llm-embedding-gap.md）；
2. M3 摄入仅文本白名单（富格式经 uploads 管线延后）；`RunAttachment` 源描述改 `IngestInput.sourcePath`（路径归属校验替代 storageKey 归属校验）；
3. lark-claw 检索「嵌入不可用降级纯词法」语义**不保留**：M3 检索工具错误即失败（显式、可观测），降级路径留待观测数据支持后再定。

## 10 开放问题

1. 嵌入能力载体 → **已解决**：dsh 0.1.0-rc.6 的 llm 能力无 embedding 接口（dsh-llm lib 无 embedding 面）；保留独立 SiliconFlow 客户端（.env 已有 SILICONFLOW_API_KEY，凭证引用纪律不变）；
2. `IngestionRun` 审计面与 admin 管理面边界 → **已解决**：IngestionRun 进 Definition（`ingestionRuns`），admin API 与模型工具共用 `ctx.knowledge`；管理面见 admin.md SPEC；
3. （新）pgvector 在便携 PG 的可用性 → infra/postgres 平移自 lark-claw（EnterpriseDB + 自编译 pgvector 0.8.1），e2e 直接验证 `CREATE EXTENSION vector`；
4. （新）多部署共享 PG 时 schema_migrations 版本冲突 → 版本号加 `knowledge/` 前缀（§9），与既有 infra 迁移隔离。
