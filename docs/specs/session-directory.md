# dsh-lark-session-directory SPEC（跨表面会话目录）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-session-directory` |
| 位置 | `packages/lark/session-directory` |
| 角色 | Definition / Provider / Consumer（Worker 内会话授权目录） |
| 状态 | proposed |
| 依赖能力 | `ctx.sessionPersistence`、`ctx.agents` |
| 提供能力 | `ctx.larkSessionDirectory` |

## 1 目的与边界

本能力为官方 Web 与飞书建立显式、可审计的会话授权关系。Web 会话默认独立；用户在该
会话执行 `/lark-share` 后获得短期一次性 claim code，飞书再用 `/session claim <code>`
把当前完整 Scope 与该会话绑定。sessionId 仅是资源标识，永远不是授权证据。

非目标：隐式合并 Web 与飞书会话、按已知 sessionId 越权恢复、把 Scope 写入 DSH header、
从 Gateway 直接读取 session log，或为非 loopback Web 设计认证。

## 2 能力缝

### Definition

`dsh-lark-session-directory` 声明 `LarkSessionDirectory`，输入只接受品牌化 sessionId、完整
Scope 与 generation；返回 DTO 不暴露绝对路径、提示词、消息正文或凭证。

### Provider

Worker 中的 provider 负责一次性 claim、长期绑定、session/header/cwd 复验与原子持久化。
目录文件默认位于 `var/session-directory.json`，配置只能修改文件路径、claim TTL 与可列出
条数上限。

### Consumer

- `dsh-lark-run`：解析当前 Scope 的目标 session，注册运行期 Scope，并管理 borrowed/owned。
- `dsh-lark-run-client`：把窄 DTO 传给 Gateway，逐字段校验 Worker 响应。
- `dsh-lark-commands`：实现 `/session current|list|use|new|claim|unlink`。
- 官方 Web：通过 Worker 内注册的 `/lark-share` 命令生成 claim code。

## 3 数据与持久化契约

长期记录最小形状为 `{ version, bindings[] }`。每条 binding 包含完整 Scope、generation、
sessionId、绑定时间和最后选择时间；不得存 claim code、cwd、preset、模型、消息内容或 token。
写入采用同目录临时文件 + 原子替换。启动时严格校验版本、字段、重复键、Scope 与 sessionId；
文件不存在视为空目录，文件损坏、未知版本或畸形记录必须启动失败，禁止静默清空。

claim 记录只存在内存，包含随机高熵摘要、sessionId、签发时间与过期时间。code：

- 默认 10 分钟过期，只能成功消费一次；
- 服务端只保存 code 摘要与一次性状态，不把明文写入目录文件、Gateway 日志或卡片载荷；
- rc.7 官方 `dsh-commands` 会把 Web handler 的返回文本写入发起 session 的 `command/done`，
  因此明文可能保留在发起者自己的 Web session log；成功 claim 后仍立即失效；
- Worker 重启后全部失效；
- 过期、重复、未知 code 统一返回不可 claim，不透露是否曾存在。

## 4 授权与校验契约

所有 `current/list/use/run` 操作必须在使用时重新完成：

1. 严格解析完整 Scope 与非负 generation；
2. 只查找当前 Scope + generation 的绑定；
3. 通过 `SessionPersistence.inspect()` 或 `listSnapshots()` 确认 session 仍存在；
4. 读取 header 并验证 `cwd` 为存在、可用的工作目录；
5. `use` 只能选择当前列表中已 claim 的 session，不能接收任意 sessionId 作为授权。

`new` 解除当前显式选择并回到 `sessionIdForScope(scope, generation)` 的确定性飞书会话；
`unlink` 移除长期绑定但不删除 DSH session log。generation 变化不会继承上一代绑定。

## 5 运行生命周期

- **borrowed**：`AgentRegistry.get(sessionId)` 已有 live agent。飞书提交 followup，禁止释放 agent、
  禁止重新挂载 preset；运行期仍注册 `sessionId -> Scope`，结束后撤销注册。
- **owned**：无 live agent。Worker 按 session header 的真实 `agentPreset` 与 `cwd` 冷恢复，
  保留日志中的 `agent-preset/selected`、模型选择和历史；只释放本次取得的 handle。
- **deterministic**：当前 Scope 无显式绑定时继续既有 per-scope session 与 `.workspaces/<scopeKey>`。

Web session 的 cwd 来自 header，绝不改写成飞书 `.workspaces/<scopeKey>`。附件、知识、工具和
artifact 访问使用运行期注册的完整飞书 Scope，而不是从 cwd 或 sessionId 推断。

## 6 HTTP 与命令契约

Worker 在既有 Bearer token 边界内提供窄 JSON 端点：

- `POST /v1/session-directory/current`
- `POST /v1/session-directory/list`
- `POST /v1/session-directory/claim`
- `POST /v1/session-directory/use`
- `POST /v1/session-directory/new`
- `POST /v1/session-directory/unlink`

请求拒绝未知字段、缺失 Scope、非法 generation/code/sessionId；响应使用稳定 DTO 与稳定
错误码，不返回绝对 cwd。手输命令以列表序号选择；飞书卡片按钮只携带服务端动作引用，
真实 sessionId 留在 Gateway 内存注册表。两者最终都走同一 Worker `use` 授权校验，不能把
card payload 或已知 sessionId 当成授权证据。

## 7 安全与失败模式

| 触发 | 结果 |
| --- | --- |
| 错 Scope / generation | 404 或稳定不可用结果，不泄露目标会话 |
| 过期、复用或未知 claim code | claim 失败且不创建绑定 |
| session 已删除或 header/cwd 无效 | 从可用结果排除；`use/run` fail closed |
| 目录 JSON 损坏、未知版本或重复绑定 | Worker 启动失败 |
| borrowed agent 正在运行 | 复用 agent 并按 DSH followup 语义排队，不创建第二 handle |
| 持久化写失败 | 操作失败，内存状态不得先行提交 |

## 8 测试契约

无密钥测试必须覆盖：

- claim 成功、过期、一次性、重启丢失和高熵生成；
- 错 Scope、错 generation、任意 sessionId 注入、重复 binding 与跨 Scope 列表拒绝；
- 文件不存在、合法恢复、损坏 JSON、未知版本和原子写失败；
- session 不存在、header 缺 cwd、cwd 不可用、列表上限与稳定排序；
- borrowed 不 dispose/不重挂 preset，owned 按 header 恢复并只 dispose 自有 handle；
- Web 独立会话不因未 claim 自动进入飞书列表；
- Worker HTTP 与 run-client 对未知字段、畸形响应和超限输入的双向拒绝；
- 卡片回调重新校验 Scope，载荷篡改不能切换任意 session。

## 9 行为变化

既有“完整 Scope + generation 确定性派生 sessionId”仍是未绑定时的默认行为。新增目录只承载
用户显式 claim 的 Web 会话，不改变 Web 新会话默认独立、`/clear` generation 语义或旧飞书
会话恢复。该能力不修改 DSH header schema，也不把授权元数据写入 session log。
