# dsh-lark-commands SPEC（网关命令）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-commands` |
| 位置 | `packages/lark/commands` |
| 角色 | Plugin（网关侧 `ctx.larkCommands` 确定性命令服务） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-9（cron 部分） |
| 依赖能力 | `ctx.larkRunClient`、`ctx.credentials` |
| 提供能力 | `/cron` `/clear` `/handoff` `/runtime` `/todo` `/session` `/login` 命令集 |

## 1 目的与边界

飞书聊天里的斜杠命令。**确定性控制面**命令在这里实现，绝不启动模型；自然语言创建类任务（如 `/cron create <request>`）路由给模型工具。

非目标：命令的解析框架（DSH commands 注册表已提供）；cron 存储实现（lark-cron）。

## 2 服务契约

注册到 `ctx.larkCommands` 的命令表：

| 命令 | M | 语义 | 确定性？ |
| --- | --- | --- | --- |
| `/clear` | M1 | 本会话重开：scope 换新 sessionId（旧会话保留） | 是 |
| `/handoff` | M1 | 只读显示会话归属；不创建旧版目标交接任务 | 是 |
| `/runtime [quick|standard|long]` | M1 | 读写本 scope 运行档位 | 是 |
| `/todo` | M1 | 展示本会话 TODO（session 投影） | 是 |
| `/session`、`/session current` | M6 | 当前会话与用量摘要 | 是 |
| `/session list` | M6 | 列出当前 Scope 已 claim 且仍可恢复的 Web 会话 | 是 |
| `/session use <序号>` | M6 | 按最新列表序号切换当前 Scope 已 claim 的会话 | 是 |
| `/session claim <code>` | M6 | 消费 Web `/lark-share` 一次性 code 并绑定当前 Scope | 是 |
| `/session new` | M6 | 回到当前 generation 的确定性飞书会话 | 是 |
| `/session unlink` | M6 | 解除显式绑定但保留 DSH session log | 是 |
| `/login` | M6 | 通过 auth-edge 一次性配对链接登录 Web，并登记发起命令所在的当前飞书会话 | 是 |
| `/cron` | M2 | 列表/详情卡（跨会话、按用户） | 是（run-client 控制端点） |
| `/cron update <job-id> …` | M2 | 更新任务文本/时刻/表达式/endAt | 是 |
| `/cron create <request>` | M2 | 自然语言创建 → 交给模型 cron 工具 | 否 |

解析规则：命令是**不可信输入**；所有 `<job-id>` 先 `parseJobId`（UUID）；session code、
序号与内部 session-id 有长度/字符上限。解析成功不代表授权，命令层先重读当前列表，且
Worker 必须按完整 Scope + generation 复核。固定枚举值外全部拒绝。

机器人菜单键使用独立确定性白名单解析，并返回同一个 `ParsedGatewayCommand`：`help`、
`session`、`cron` 直达同名命令；旧键 `new` 映射为当前 `/clear`，旧键 `preset` 映射为
当前 `/runtime`；当前键 `clear`、`runtime`、`todo`、`handoff` 同样支持。未知、带首尾空白
或自由参数的 eventKey 返回 `undefined`，不得拼接成命令执行。

## 3 配置契约

```ts
interface Config {
  /** 运行时档位默认值（默认 standard）。 */
  defaultProfile?: 'quick' | 'standard' | 'long'
  /** 卡片 action 的服务端引用存活时间；默认 10 分钟。 */
  cardActionTtlMs?: number
  /** 未消费 action 的最大数量；超过时逐出最旧条目。 */
  cardActionMaxEntries?: number
  /** auth-edge loopback 配对签发端点；缺省时 /login 返回配置提示。 */
  pairingEndpoint?: string
  /** 配对端点 Bearer 凭证引用，缺省为 AUTH_PAIRING_TOKEN。 */
  pairingTokenEnv?: string
}
```

部署配置的安全边界为：`cardActionTtlMs` 只能是 `1..86_400_000` 毫秒，
`cardActionMaxEntries` 只能是 `1..10_000`；字段缺省才使用默认值，超界、非整数、
不安全整数和显式零值均在插件注册前 fail loud。

## 4 事件契约

发布：`lark/command/clear-session`（`/clear` 触发，网关递增完整 Scope 的 generation）。
消费：`lark/message/received`（经 gateway 分流）。

## 5 模型可见面

无（命令不进模型；`/cron create` 例外——转为模型工具调用，由 lark-cron 工具承载）。

## 6 行为契约

- 命令处理不产生模型运行（`/cron create` 除外）；
- 每个命令对非授权/未知参数 fail loud（提示正确用法，不回退执行）。
- 菜单命令与聊天斜杠命令共用 `handle()`，菜单解析不得建立第二套执行器。
- `/session` 子命令只调用 run-client；list/use/run 不缓存授权结果，claim 失败不创建本地状态。
- 手输 `/session use <序号>` 必须先重读 Worker 当前 Scope 列表；卡片动作在服务端引用中固定
  列表生成时的 sessionId，避免列表重排后错选。两条路径都必须再次调用 Worker `use` 复核
  Scope；已知任意 sessionId 不能绕过 claim。

## 7 安全与信任

- job-id 永非所有权证据：所有 cron 命令经控制端点按 Scope 复核（lark-claw 语义）；
- session-id 与卡片 actionId 同样不是所有权证据：回调消费服务端 command 引用后仍由 Worker 复核 Scope；
- 命令不读 `.env`、不打印密钥。
- `/login` 只向配置的 loopback auth-edge 端点发送当前 Scope 的 Feishu `open_id`，Bearer
  值经 `ctx.credentials` 解析；浏览器 token 只由 auth-edge 签发、短期有效且一次性消费。
- `/login` 不使用 Feishu OAuth，不接受浏览器或消息正文提供的用户身份；allowlist 仍由 gateway
  在命令层之前执行。
- 配对请求体由 Gateway 服务端生成 `{ openId, sessionId }`：`sessionId` 是当前完整 Scope +
  generation 的 deterministic 派生值，不接受飞书消息或浏览器自带的任意资源 ID。auth-edge
  消费 token 后才把该会话写入当前 Auth 用户资源表；重复消费、过期 token、跨用户资源冲突均
  失败关闭。

## 8 测试契约

- `unit`：每命令的解析（合法/非法/越权参数）与路由；
- `unit`：菜单 eventKey 白名单、`new`/`preset` 兼容映射与未知键 fail closed；
- `unit`：`/runtime` 进程内读写（scope 隔离，重启回默认）；
- `unit`：`/todo`、`/session` 只向 run-client 发送完整 Scope + generation，并渲染持久化会话投影；
- `security`：`/session claim/use/list/new/unlink` 拒绝多余参数、超限 code、未授权 sessionId、错 Scope 和重复卡片回调；
- `unit`（M2）：cron 命令对控制端点的调用与回调命令白名单。
- `unit`（M6）：`/login` 成功返回配对 URL 和当前 `bound`/`unbound` 状态，状态渲染在
  持久交互卡片中；配置缺失/端点失败返回明确失败卡，且不触发 Worker 运行；配对客户端拒绝
  非 loopback 端点、非 `/auth/pair` 响应、缺失绑定状态和超长 URL。

### /cron 确定性管理（R-18 补齐）

- `/cron` | `/cron list`：任务列表（≤10 行 + 最近执行 3 条）；`/cron <jobId>`：详情；`/cron pause|resume|delete <jobId>`：暂停/恢复/删除。jobId 过 `parseJobId`，失败回用法卡。
- `/cron` 的固定操作严格拒绝多余参数；未知参数不得静默退化为列表、详情或其他操作。
- 走 `runClient.cronControl`（worker `/v1/cron-control`，wire 见 contracts run.ts）；控制面失败降级提示（不影响聊天）。
- lark-claw 的卡片表单编辑与分页浏览**不迁移**——编辑 = 删除 + 自然语言重建（模型面 cron_schedule 工具）。

### M6 命令操作卡扩展

命令结果可以返回 `markdown` 与已注册的操作按钮。按钮的飞书 callback value 只能含
`actionId`；`command` 仅保存在 `ctx.larkCommands` 的内存注册表中。每条记录包含
完整 `scopeKey(scope)`、原始命令、创建时间与过期时间。

- gateway 在 allowlist 授权后调用 `handleCardAction()`；provider 必须比较 actionId、完整
  Scope 与记录内命令，再原子删除记录并执行一次。
- 未注册、过期、Scope 错配或已消费的 action 统一返回“操作已过期或无效”的确定性卡，
  不进入模型、`runFlow` 或 worker。
- registry 只在进程内存中保存；重启会使既有按钮失效，这是 fail-closed 语义。
- `/help`、`/runtime`、`/todo`、`/session`、`/handoff` 与 `/cron` 返回上下文相关的操作
  卡。`/clear` 与 `/cron delete` 的按钮带飞书确认框，但确认框不是授权证据。
- `/session list` 的切换按钮把当时选中的 sessionId 只保存于服务端 action registry，避免
  点击前列表重排导致错选；飞书 callback value 仍仅含 `actionId`，不得携带 claim code、
  sessionId 或 Scope。消费后仍调用 Worker `use` 复核授权。

### M6 测试契约补充

- `security`：callback wire 值不含 command；未注册、过期、跨 Scope、重复与并发回调均
  不触发命令副作用或 worker run。
- `unit`：action registry 容量逐出、TTL 清理与一次性消费；`/help`、`/runtime`、`/cron`
  的操作卡结构与危险按钮确认。
- `snapshot`：命令结果只含白名单 markdown、标签和 action ID，不含 Scope、凭证或模型内容。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/cron-command.ts` / `cron-management.ts` | M2 复用（列表/详情卡与更新命令） |
| `apps/lark-gateway/src/session-command.ts` | 改为 DSH session log 只读投影 |
| `apps/lark-gateway/src/handoff-command.ts` | 正式降级为只读归属视图；旧目标交接任务不迁移 |
| `apps/lark-gateway/src/runtime-profile-command.ts` | 复用（档位读写） |
| `apps/lark-gateway/src/todo-command.ts` / `todo-management.ts` | 降级为 session 投影视图（DSH tool-todo） |
| `apps/lark-gateway/src/session-usage-command.ts` | 复用 |

行为变化：`/todo` 从 PG 管理面降级为会话本地视图（已记录于蓝图 §9）。M1 实施记录：

1. **命令表自有实现**：dsh `ctx.commands` 注册表是进程内 agent 语义（handler 针对具体 agent 执行、经 Typert 远程面），网关侧路由（命令发生在 worker agent 创建之前）使用本包自有轻量表 `ctx.larkCommands`；M4 起与 worker 侧 dsh-commands 按需对接。
2. **`/todo`、`/session` 已接入持久化投影**：Gateway 传完整 Scope + generation；未绑定时
   使用确定性 sessionId，显式 claim 后由 session-directory 复验当前目标，再折叠最新
   `todo/write`、运行次数与 `assistant/message.usage`。
3. `/clear` 经 `lark/command/clear-session` 事件交网关递增会话代次（见 lark-gateway SPEC）。
4. 机器人菜单只在本包把 eventKey 解析成现有命令；授权、eventId 去重、P2P Scope 解析与结果发送仍由 Gateway 负责。

## 10 开放问题

1. ~~`/runtime` 档位存储载体~~ **已解决（M1）**：进程内 Map（scopeKey 分键），重启回默认 standard；M2 与 scope→sessionId 同源迁移到持久层时再评估。
