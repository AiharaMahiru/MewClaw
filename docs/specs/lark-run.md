# dsh-lark-run SPEC（执行面核心）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-run` |
| 位置 | `packages/lark/run` |
| 角色 | Plugin（运行服务器：per-scope 调度、期限、事件流桥接） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-2, ADR-4, ADR-6 |
| 依赖能力 | `ctx.agents`、`ctx.sessions`、`ctx.sessionPersistence`、`ctx.credentials`、`ctx.larkSessionDirectory` |
| 提供能力 | `POST /v1/runs` 及控制端点（worker 侧 HTTP 面） |

## 1 目的与边界

worker 进程内唯一执行入口：接收经网关授权的 `RunRequest`，按 Scope 调度（串行 + 并发上限），挂载对应 agent preset 会话执行，把 **DSH session 事件流**以 NDJSON 桥接给网关。

非目标：Feishu 任何细节（连错误文案都不写）；知识/cron/记忆的实现（只作调用点）；沙箱策略（sandbox 能力自行承担）。

## 2 服务契约

HTTP 面（自带窄 HTTP server，默认绑定 loopback，非 host-webserver）：

| 端点 | 语义 |
| --- | --- |
| `POST /v1/runs` | 校验 RunRequest → 入队 → `200` + `application/x-ndjson` 流（session 事件 + 心跳空行） |
| `POST /v1/runs/:runId/cancel` | 取消排队中或运行中的 run（agent abort） |
| `POST /v1/interaction/resolve` | 网关送达交互问卷答案（interactionId + answer；worker 内广播 `lark/interaction/resolved`，消费方 lark-approval） |
| `POST /v1/session-overview` | 完整 Scope + generation → 当前已授权目标 session → 只读折叠 TODO/运行/token；不存在统一返回 `exists:false` |
| `POST /v1/session-directory/current` | 返回当前确定性或已 claim 的 session 资源标识 |
| `POST /v1/session-directory/list` | 列出当前完整 Scope + generation 已 claim 且仍可恢复的 session |
| `POST /v1/session-directory/claim` | 消费短期一次性 code，并原子持久化 Scope 绑定 |
| `POST /v1/session-directory/use` | 选择当前 Scope 已 claim 的 session；任意未授权 sessionId 拒绝 |
| `POST /v1/session-directory/new` | 回到当前 generation 的确定性飞书 session |
| `POST /v1/session-directory/unlink` | 移除当前显式绑定，不删除 DSH session log |
| `POST /v1/artifacts/read` | 完整 Scope + artifactId + 安全 basename + SHA-256 + 字节数 → 仅返回当前 Scope 工作区中完全匹配的安全 raster 图片；不可用、错 Scope、改变或非图片统一 404 |
| `GET /healthz` | 存活 + 队列深度摘要（不含 scope 详情） |
| `POST /v1/cron-control` | M2：确定性 cron 控制（SPEC cron.md） |

鉴权：Bearer token（`timingSafeEqual` 比较），token 值经凭证引用读取。

## 3 配置契约

```ts
interface Config {
  /** 监听主机（仅 127.0.0.1 / 0.0.0.0 两值，默认 loopback；0.0.0.0 必须配 token）。 */
  host?: '127.0.0.1' | '0.0.0.0'
  /** 监听端口（默认 8787）。 */
  port?: number
  /** worker 凭证引用名；缺省 = loopback 无鉴权开发模式；0.0.0.0 缺失时 fail loud。 */
  tokenEnv?: string
  /** 兼容旧配置的统一无进展窗口；为未单独配置的 profile 提供回退值。 */
  runTimeoutMs?: number
  /** 硬上限（默认 0 = 不设绝对上限）。 */
  runHardTimeoutMs?: number
  /** 档位超时：quick / standard / long（默认 5m / 20m / 60m，优先于 runTimeoutMs）。 */
  profileTimeouts?: { quick: number; standard: number; long: number }
  /** 全局并发运行上限（默认 4）；每用户上限（默认 1）；每 scope 排队上限（默认 3）。 */
  concurrency?: { maxRuns: number; maxRunsPerUser: number; maxQueuedPerScope: number }
  /** 心跳空行间隔（默认 15s）。 */
  heartbeatIntervalMs?: number
  /** 飞书 bot 模板 id（默认 `lark-standard`；控制技能、人设与检索策略）。 */
  presetId: string
  /** DSH agent preset id（默认 `standard`；控制工具、Shell 与 Agent 组装）。 */
  agentPresetId?: string
  /** 会话工作区根（`.workspaces`；默认 <cwd>/.workspaces）。 */
  workspaceRoot?: string
}
```

`port` 必须是 `0..65535` 的安全整数（`0` 仅用于本地/测试的动态端口）。`runTimeoutMs`、各档 `profileTimeouts` 与 `heartbeatIntervalMs` 必须是正安全整数且不超过 Node 定时器上限；`runHardTimeoutMs` 可为 `0` 表示关闭硬上限；三个并发值必须是正安全整数。`runTimeoutMs` 仅为兼容旧配置：它会填充未显式给出的 profile 值，显式 `profileTimeouts` 始终优先。

## 4 事件契约

发布（NDJSON 流出，同时已在 session log 落盘）：session 事件流原样透传 + 运行信封 `{ runId, scope }` 每事件校验。
发布（进程内）：`lark/run/lifecycle`（仅 runId + 固定 phase/outcome 值 + 时长；无 scope/提示词/路径）。

## 5 模型可见面

无直接工具；执行的 agent 由 preset 挂载（preset 决定工具/技能/提示词段——见 bundles.md）。本包只保证：**Scope 注入**（工作区根、会话元数据）与**运行期限**对模型行为透明。

模型可见 ⟺ 落盘：本包在提交提示词前写入原始 `lark/message/in`，有 preset 时写入
`lark/run/preset`；附件准备写入 `lark/run/context`，记忆召回写入
`lark/memory/recalled` 的条数。最终增强后的提示词由 agent 正常 `user/message` 事件承载，
因此模型输入可从 session log 重建。

## 6 行为契约

不变量：

- 同一 Scope 的运行严格串行（per-scope 队列）；不同 Scope 并行（受全局/每用户上限）；
- 排队中 run 在取消/超时后**不**启动模型请求；
- 无进展窗口由主机观测的会话事件续期（与 lark-claw 语义一致，见其 AGENTS.md 运行期约束）；
- 运行结束判定：有可见助手文本或产物 = 成功；否则 `EMPTY_RESPONSE`（网关据此替换卡片）；
- Worker 创建 Scope 工作区后、agent 运行前记录顶层交付物基线；成功结束时只收集本轮新增或摘要/大小变化的常规文件；
- 会话创建失败（含技能预检失败）fail closed → `SESSION_CREATE_FAILED`。
- 当前 Scope 有显式绑定时先由 session-directory 复验 session/header/cwd；未绑定时继续确定性会话。
- live agent 采用 borrowed 生命周期：只提交 followup，不重挂 preset、不 dispose；冷 session 采用
  owned 生命周期，按 header 的 `agentPreset` 与 `cwd` 恢复，只 dispose 本次 handle。
- borrowed 运行期间仍注册 `sessionId -> Scope`，结束后撤销，附件、知识和工具不得从 cwd 推断 Scope。
- 飞书 bot 模板与 DSH agent preset 是两套独立命名空间；新会话 header 只记录
  `agentPresetId`，恢复时按 header 与 `agent-preset/selected` 事件重建实际 DSH preset。
- 历史 header 中的 `lark-standard` 不改写原始日志；该持久化 ID 现在对应展示名“飞书全功能模式”，
  在 full/OCI profile 复用当前 DSH `standard` 组合，使旧会话仍可恢复；lightweight roster 不再
  暴露该 ID。
- artifact read 仅调用 `ctx.larkUploads.readImageArtifact()`；工作区路径由 `workspaceRoot + scopeKey(scope)` 在 Worker 内派生，Gateway 永不获得路径或目录读取能力。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 未鉴权 / token 不符 | `401` | 网关侧修复凭证引用 |
| RunRequest 校验失败 | `400` + 错误码 | 网关侧 bug 修复 |
| 队列满 / 并发满 | `QUEUE_FULL`（网关转失败卡） | 用户稍后重试 |
| 无进展超时 | abort + `RUN_TIMEOUT` 事件 | 用户重发 |
| 硬上限到期 | abort + `RUN_TIMEOUT` | 用户重发 |
| 会话创建失败 | `SESSION_CREATE_FAILED` | 环境修复 |
| 绑定会话未授权、已删除或 cwd 不可用 | `SESSION_NOT_AVAILABLE` | `/session new` 或重新 claim |
| 会话目录损坏/写失败 | `SESSION_DIRECTORY_FAILED` | 修复目录文件或磁盘状态后重启 |
| artifact 不存在、Scope/摘要/大小/ID/MIME 不匹配 | `404`，不返回路径或内容 | 用户重新生成；Gateway 保留成功 run 并显示交付失败提示 |
| 进程崩溃/重启 | 未完成运行丢失（M2 起评估恢复语义） | M2 前接受；记录于证据 |

## 7 安全与信任

- Scope 来自 HTTP 输入 → `parseScope` 校验；但**信任已由网关授权**（worker 不重复 allowlist 判断，token 是信任边界）；
- 交互解答请求仅接受 `scope`、`interactionId`、`answer` 三个字段；选择项最多 64 个，单项与自定义文本最多 4000 字符；
- 会话工作区根必须落在 `workspaceRoot` 内（路径规范化 + 拒绝逃逸）；
- Web 绑定会话使用 header 的真实 cwd；只有确定性飞书会话派生 `workspaceRoot + scopeKey(scope)`；
- sessionId 不是授权证据；运行前必须重新验证它属于当前 Scope + generation 的 claim 集合；
- artifact read 请求严格拒绝未知字段和不安全值；Worker 复算文件摘要、ID、字节数和真实图片 MIME，二进制响应带 `content-length` 与 `content-type` 且不缓存；
- 日志只记 runId/phase/outcome/时长（继承 lark-claw 运行期约束）。

## 8 测试契约

- `unit`：per-scope 串行 / 跨 scope 并行 / 取消排队中运行；
- `unit`：无进展窗口续期与到期、硬上限、空回复判定；
- `unit`：token 鉴权（含时序安全）、RunRequest 全部拒绝用例；
- `unit`：session-overview 拒绝缺失 Scope/非法 generation，且不同完整 Scope 不读取其他用户日志；
- `security`：run/list/use 拒绝未 claim sessionId、错 Scope/generation 与无效 header/cwd；
- `unit`：borrowed agent 不 dispose/不重挂 preset，owned 按 header 恢复并只 dispose 自有 handle；
- `security`：artifact read 的鉴权、完整 Scope、未知字段、路径逃逸、未知 ID、摘要/字节不符、非图片 MIME 与 response header；
- `unit`：运行前 artifact 基线在 agent 创建前建立，成功收集只能消费该基线；
- `unit`：会话创建失败清理（无残留状态）；
- `unit`：新会话写入并挂载 `standard`；恢复按日志中的实际 preset 挂载，历史
  `lark-standard` 与后续 `agent-preset/selected` 均不被部署默认值覆盖；
- `composition`：Windows 下官方 `standard` 含 `tool-pwsh`，full/OCI roster 的“飞书全功能模式”
  可解析并引用当前 DSH `standard` 组合；lightweight roster 不暴露执行型 preset；
- `snapshot`：NDJSON 流与 session log 重放一致（无密钥重放）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/pi-worker/src/scoped-run-executor.ts` | 复用（队列/并发语义） |
| `apps/pi-worker/src/http-server.ts` / `worker-api.ts` / `ndjson.ts` | 复用（端点骨架、NDJSON 帧、心跳） |
| `apps/pi-worker/src/main.ts` | 删除（组合进 apps/lark-worker cordis.yml） |
| `packages/pi-runtime/src/*`（PiRunner/ExecutionBudgetController 等） | **删除**；执行预算语义保留在本包 §6 |
| `apps/pi-worker/src/interaction-store.ts` | 移入 dsh-lark-approval（PG 待办） |

行为变化：Pi 会话工厂/事件翻译删除；session 事件流取代 `UiEvent` 联盟（ADR-4）。M1 实施记录：

1. **RunRequest 增 `messageId`**（contracts §4.3 同步更新）：lark/message/in 的来源记录需要触发消息 id。
2. **NDJSON 终止行**（contracts `RunStreamDone`）：每流最后一行携带 `{ code: "OK" } | LarkErrorWire`——网关据此做空回复替换/失败卡。
3. **queueTimeoutMs 暂缓**（M2 随跨进程恢复评估）：M1 队列只在进程内，排队等待默认直到活跃 run 结束。
4. **SessionEventMap 增强目标必须是 `@deepseek-ai/dsh-session/types` 子路径**（根包名身份会与 dsh-agent 等生态增强竞争导致合并丢失）——证据 docs/evidence/m1-session-eventmap-augment-target.md。
5. **`runTimeoutMs` 保持兼容回退**：M4 新增 profile 档位后，旧统一超时必须继续进入实际无进展窗口；无效数值在 worker 启动时 fail loud，不能拖延到队列、定时器或 HTTP listen。
6. **图片交付受限读取**：通用 artifact 下载不迁移；仅由 Gateway 在收到图片 artifact 事件时向 Worker 请求经 Scope、basename、摘要、字节和 MIME 复验的图片字节，成功运行不因图片发送失败改写为失败。

## 10 开放问题

1. ~~`ctx.agents` 动态创建/恢复/中止会话的精确 API~~ **已解决（M0 spike，证据 docs/evidence/m0-dsh-api-surface.md）**：
   - 创建：`agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup, signal })` → `{ agent, dispose() }`；
   - 恢复：`agents.resume({ resumeSessionId, agentOptions, setup })`（M1 验收「重启恢复不重放副作用」依赖）；
   - 驱动：`agent.followup(createUserMessage(...))` / `agent.whenIdle()`；取消：`agent.cancel(cause, options)`；
   - 事件流：`agent.session.events`（`{ seq, time, type, data, ignorable? }`），NDJSON 逐行透传 + 信封校验。
2. ~~scope→sessionId 持久映射载体~~ **已解决**：未显式绑定时仍确定性派生
   `sessionId = session-<scopeKey(scope, generation)>`；跨 Web/飞书共享只接受
   [session-directory.md](session-directory.md) 的显式一次性 claim，不以 sessionId 作为授权。
3. 队列语义跨进程恢复（M2 评估：DSH session 是否可续跑中断的 turn）。
