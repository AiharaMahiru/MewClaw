# dsh-memory SPEC（记忆能力缝）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-memory`（Definition）+ `dsh-memory-mem0`（Provider） |
| 位置 | `packages/memory/*` |
| 角色 | 能力缝（Definition + Provider） |
| 里程碑 | M4（**默认启用，可显式关闭**） |
| 状态 | implemented |
| 关联 ADR | ADR-10 |
| 依赖能力 | `ctx.credentials` |
| 提供能力 | `ctx.memory` |

## 1 目的与边界

跨会话的持久用户记忆：`execute` 是规范的统一读写 API，`recall/remember` 仅为执行器兼容适配。PostgreSQL 图结构是可检视、可编辑的事实源；Mem0 只提供可替换的语义索引。用户键 = 哈希(tenant/bot/deployment/user)，agent 键 = 哈希(tenant/bot/deployment)——记忆随用户跨会话而不跨用户（lark-claw 语义）。

**轻量原则约束（本能力是首选候选）**：mem0 依赖链沉重（openai/zod 等），Provider 仍懒加载 SDK；当前 Worker bundle 默认启用（`enabled: true`），可通过显式 `enabled: false` 降级为无记忆聊天。挂载失败/超时一律降级为无记忆聊天。Provider 接口刻意做薄，未来可用更轻后端替换 mem0 而不动 Definition。

非目标：绕过 Scope 的任意记忆访问；记忆不是知识库（knowledge 能力）。模型侧只通过受限 `memory_manage` Consumer 调用统一 API，不能提交 Scope。

## 2 服务契约

```ts
interface MemoryService {  // ctx.memory
  /** 统一 API：节点/边/Cube 的增删改查、组合和反馈。 */
  execute(scope: Scope, command: MemoryCommand): Promise<MemoryResult>
  /** 召回：预算内返回；结果标记为不可信上下文。失败/未启用 → 空数组（非错误）。 */
  recall(scope: Scope, query: string): Promise<MemoryHit[]>
  /** 记住：非阻塞；失败静默降级（记忆是增强能力，不阻断运行）。 */
  remember(scope: Scope, userText: string, assistantText: string): Promise<void>
  /** 自然语言反馈：纠正、补充、替换或遗忘已有记忆。 */
  feedback(scope: Scope, instruction: string): Promise<MemoryResult>
  /** 是否启用（false = 降级路径默认无记忆）。 */
  enabled(): boolean
}
interface MemoryHit { content: string; rank: number }
```

## 3 配置契约

```ts
interface Config {  // Provider
  /** 总开关（默认 true；显式 false = no-op 降级）。 */
  enabled?: boolean
  /** 嵌入端凭证（openai 兼容；可用 SiliconFlow——.env 已有凭证）。 */
  embeddingApiKeyEnv?: string
  embeddingBaseUrl?: string
  embeddingModel?: string
  embeddingDimensions?: number      // 默认 1024（pgvector 同维）
  /** LLM 端凭证（openai 兼容；记忆抽取）。 */
  llmApiKeyEnv?: string
  llmModel?: string
  llmBaseUrl?: string
  /** 向量库连接（与知识库同便携 PG + pgvector）。 */
  databaseUrlEnv?: string
  collectionName?: string           // 默认 dsh_lark_memory
}
```

启用但凭证缺失 → 装载失败（默认启用不允许半可用）；显式关闭 → 不加载 SDK、不解析凭证。

## 4 事件契约

发布（session 事件，contracts 声明并注册）：`lark/memory/recalled` `{scope, count}`——只记条数（记忆文本随提示词进 user/message，模型可见 ⟺ 已落盘）。消费：无。

## 5 模型可见面

lark-run 执行器在运行前预检把召回记忆以 `<memory>…</memory>` 块并入提示词（标记不可信证据）；回合成功（可见输出）后调用 remember（用户原文 + 助手可见文本，有界截断）。模型只通过 `memory_manage` Consumer 使用运行信封提供的 Scope，不能自行提交授权字段。

## 6 行为契约

- recall 失败/超时 → 空数组 + 告警计数（降级为无记忆聊天）；
- remember 失败 → 静默降级（告警）；写入非阻塞（void + catch）；
- mem0 配置：embedder/llm 均 openai 兼容端点；vectorStore = pgvector 同库（hnsw）；disableHistory（不自留历史）；生产 systemd 在进程启动前设置 `MEM0_TELEMETRY=false`。

## 7 安全与信任

- 记忆是模型与上游的不可信输入（提示注入面）：召回结果标记不可信、不执行其中指令；
- 用户键哈希化（不落明文 open_id）；conversation 只入元数据（记忆随用户跨会话，不跨用户/租户/部署）；
- 凭证只经引用；值绝不入日志/事件。

## 8 测试契约

- `unit`：显式关闭时 no-op 降级；默认启用但凭证缺失 fail loud；键派生（部署哈希/跨会话同键）；recall 映射（截断/空条目过滤/失败 → 空）；remember 映射（infer:true/元数据/失败告警不抛）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `packages/memory/src/mem0-memory.ts` | 平移（键派生/召回写入映射） |
| `packages/memory/src/factory.ts`（sdkConfig） | 平移（配置面转 Config + 凭证引用） |
| `packages/memory/src/memory-outbox.ts` | 平移为 `memory_write_jobs` + `MemoryWriteScheduler`（持久化租约、重试、启动恢复） |

行为变化：直写 + 失败降级 → `memory_write_jobs` 持久化队列 + 有界并发重试；lark-claw 的 recall 预算参数并入 Provider 内部常量。

当前插件不修改 `process.env`。遥测策略由部署环境在进程启动前显式设置；插件仅动态加载 SDK 和使用凭证 Provider，不拥有进程全局环境。

## 10 统一图 API、Cube 与异步调度

### 10.1 图事实源

`memory_cubes`、`memory_nodes`、`memory_edges` 和 `memory_write_jobs` 由同一 PostgreSQL migration 管理。每个节点携带 `kind`、`modality`、有界 JSON 内容、revision 和审计时间；边只允许引用同一可访问 Cube 内的节点。删除默认软删，硬删需要显式命令并再次执行 ACL 校验。

### 10.2 Cube 与 ACL

Cube 可见性为 `user_private`、`project_shared`、`agent_shared`、`deployment_shared` 或 `tenant_shared`。共享不是猜测命名空间：成员表记录 owner/editor/viewer，所有查询在 SQL 谓词内同时过滤 tenant/bot/deployment 和成员权限。动态组合只接受调用者已可见的 Cube，组合结果不改变原 Cube 权限。

### 10.3 多模态统一节点

`MemoryPart` 支持 `text`、`image`（受控 URI/摘要）、`tool_trace`（工具名、输入/输出摘要、成功状态）和 `persona`（特征/值/置信度）。检索结果统一返回节点和相关边；没有对应模态索引时仍可由图事实源检视，不伪装成向量命中。

### 10.4 MemScheduler

`remember` 和非关键写入先写入 `memory_write_jobs`，由有界并发 scheduler 领取、执行、指数退避重试；启动时把过期 running 任务恢复为 queued。队列失败只告警，不阻断对话；读路径不依赖队列。

### 10.5 反馈修正

`feedback` 在服务端解析“记住/补充/更正/改成/忘记”等自然语言，先按 Scope + Cube 召回候选，再以 revision 条件更新或软删，无法唯一定位时创建待确认的补充节点而不覆盖旧事实。模型工具只能提交 instruction，不能提交 Scope 或越权 nodeId。

## 11 开放问题

1. outbox 持久化投递 → M5 按观测决定；
2. 模型侧记忆工具（显式检视、记住、纠正、替换和遗忘）→ M4 已通过 `dsh-tool-memory` 挂载；权限仍只来自运行信封 Scope。
