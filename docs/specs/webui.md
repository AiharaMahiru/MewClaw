# dsh-lark WebUI SPEC（官方 dsh Web 聊天面 + 独立管理面）

| 元数据 | 值 |
| --- | --- |
| 包 | `@deepseek-ai/dsh-web-app` + `dsh-context` + `@linxin666/dsh-web-all`（含 `dsh-better-sidebar`）+ `dsh-lark-web-bundle`；管理面为 `dsh-lark-admin` + `apps/admin-web` |
| 位置 | `apps/lark-worker/`、`packages/bundle/web/`、`packages/lark/admin/`、`apps/admin-web/` |
| 角色 | 官方 Web Host/Consumer + dsh-lark 部署覆盖；管理面独立 Provider/Consumer |
| 里程碑 | M6 |
| 状态 | implementing（官方 Web 已接入；第三方 Web 扩展按精确版本组合） |
| 依赖能力 | `webServer`、API Proxy、Connection、Session、Workspace、Agent、SessionPersistence |
| 提供能力 | `/` 官方聊天 Web、`/api/*` RPC/事件、Worker 既有 `/v1/*`、独立 `/admin/*` 管理面 |

## 1 目的与边界

本 SPEC 的主产品面是官方 dsh Web 聊天 UI。当前 dsh-lark Worker 直接装载
`@deepseek-ai/dsh-web-app`，由官方前端和协议提供会话、流式消息、停止/取消、
附件、工作区、工具、任务/计划、审批问题、设置、模型、交付物、工作流、轨迹、
技能和 slash 命令等完整 UI 能力。不得用自研 admin 页面替换或删减这些官方模块。

`@deepseek-ai/dsh-web` 是 Web capability definition（搜索/抓取 provider 选择面），
不是 React 聊天页面；`@deepseek-ai/dsh-web-app` 才是官方 Web Host 与前端组合。
这两个包的职责不能混写。

`apps/admin-web` 仍是独立的管理控制面，服务知识管理、健康检查和必要的只读观察。
它不加载 `dsh-base`、Agent、工具或执行面，也不限制官方聊天 Web 的能力。管理面契约
见 [admin.md](admin.md)，其浏览器请求继续限定为 `/api/admin/*`。

Definition / Provider / Consumer 分工：

| 角色 | 所有者 | 职责 |
| --- | --- | --- |
| Definition | 官方 `dsh-web`、Session、Workspace、UI contracts | 定义 Web 能力、事件、RPC 和会话数据契约。 |
| Provider | 官方 `dsh-web-app` 及其 Host/API/Connection/UI providers | 注册 Web Host、API Proxy、事件通道和完整官方 UI roster。 |
| Consumer | 官方 Web frontend | 通过 `/api/*` 和 WebSocket 消费 Worker 的会话、工具和 UI 事件。 |
| Extension | `dsh-context`、`@linxin666/dsh-web-all`、`dsh-better-sidebar` | 通过官方 bundle/client 注入机制扩展上下文面板、Web 工作台与右侧文件工作区。 |
| Deployment overlay | `dsh-lark-web-bundle` | 只覆盖 MewClaw persona、agent preset 根和 Web profile 的 provider 边界。 |

所有本地扩展继续使用 Cordis `ctx.effect()` / `ctx.on()`；不修改 dsh 框架源码，
不复制官方 UI 到仓库内维护。

## 2 官方组合

Worker profile 的加载顺序固定为：

```text
@deepseek-ai/dsh-base
  -> dsh-lark-base
  -> dsh-lark-worker
  -> @deepseek-ai/dsh-web-app
  -> dsh-context
  -> @linxin666/dsh-web-all
  -> dsh-lark-web-bundle
```

第三方扩展固定为以下可重放组合：

| 包 | 版本 | 角色与边界 |
| --- | --- | --- |
| `dsh-context` | `0.25.3` | host/client 双端 bundle；提供 Context tab 与 `/context`，复用官方 session、projection 与 token meter。 |
| `@linxin666/dsh-web-all` | `0.3.6` | 上游推荐的新 Web 聚合 bundle；安装独立行，实际激活项继续受本地 Web 与隔离 profile 政策约束。 |
| `dsh-better-sidebar` | `0.15.2` | 由聚合包精确依赖并以 `web-ui-better-sidebar` 唯一挂载；只在允许本机执行的 full/OCI profile 激活。 |

组合纪律：

- `dsh-better-sidebar` 不再作为独立 profile bundle 重复列出；聚合包已拥有其唯一挂载行，双挂载会产生两个 host/client 实例与两个侧栏；
- 第三方 bundle 只进入 Worker Web profile，位于官方 `dsh-web-app` 之后、本地 `dsh-lark-web-bundle` 之前；因此官方能力先就位，本地 persona、preset 和 provider 政策最后生效；
- 所有外部包精确锁定，不跟随 `latest` 或范围漂移；新增原生构建脚本只允许上游实际依赖的 `cloudflared`、`cpu-features`、`ssh2` 与既有 `node-pty`；
- 不扩大 `trustedHosts`、监听地址或 CORS，不在仓库保存 SSH、隧道、视觉或其他凭证。外部插件自有本地状态不得被当作飞书 Scope 授权证据；若未来把其状态接入飞书链路，必须另立 SPEC 和完整 Scope 契约。

本地政策层固定禁用以下聚合行：旧 aionui panel（改由 better-sidebar 提供文件与 HTML
预览）、plugin-manager 与 market（生产是只读不可变 release，不存在可写的
`~/.dsh/profiles/web`）、desktop-launcher（不得从浏览器关停生产进程、写宿主桌面或发送
外部遥测）、doctor（未部署其 Supervisor）、perf（不得隐式改写会话持久化配置）、task-board（与完整
Scope 的 `dsh-lark-cron` 重叠）、remote-web（非 loopback 暴露尚无本仓库认证 SPEC）、SSH
（凭证和远程执行边界不符合当前部署合同）、describe-image（复用现有凭证引用式
`dsh-lark-vision`）和第三方 Liangshen 同步插件（不得写入用户 preset 根或覆盖平台
persona/隔离策略）。仓库 system root 提供经过审阅的“全能优化模式” preset。
lightweight 与 full 对齐，启用 git-graph 与 better-sidebar；OCI 的执行仍由容器 Provider 承载。
用户关闭 pet 时，lightweight 直接禁用 `web-ui-pet`，避免上游 client
在 host 注销 `/api/pet/*` 后继续轮询 404，不得反向把 `pet.enabled` 改回 true。`dsh-context`、
Web UI settings、community catalog、skill explorer 与 skin center 在三个 profile 均可激活。
聚合包附带的 better-session 三行保持显式禁用，不替换官方 JSONL 会话事实源。
普通用户可读取 `dsh-web-ui-settings/describe`，但 `mutate` 与其他未知 slash API 继续拒绝。
主站响应保持 `X-Frame-Options: DENY`；只有经会话归属校验的 `/sidebar/html/*` 使用
`SAMEORIGIN`，供 better-sidebar 的沙箱 iframe 显示用户工作区 HTML。
本地最后一层同时重述 `session-persistence-jsonl` 的既有 root、Zstandard 编码、分片打包、
缓存和 `200ms` 写入延迟，抵消聚合包 Perf 行的独立 `500ms` 覆盖。

agent preset 必须与执行隔离 profile 成对选择：

2026-09-10 变更：lightweight 不再裁剪执行能力，账号、工作区归属、审批及 OCI Provider 边界不变；工具是否可执行以当前宿主实际能力与授权为准。

- `lightweight` 使用仓库随 `dsh-lark-web-bundle` 分发的 `lark-lightweight`，以公开 include 复用官方 standard，不复制或裁剪工具清单；
- `lightweight.overlay.yml` 同时把 Web `agent-presets.default` 与 `dsh-lark-run.agentPresetId`
  设为 `lark-lightweight`。其 roster 与 full 共用 system roots，并设置
  `includeUserRoot: false`，用户目录中的任意 preset 不会进入选择面。
  Cordis patch 会整体替换 config，因此两行都必须重述各自完整配置；
- Auth Edge 的普通用户会话可选择当前 Worker 已暴露的 system-only roster；默认仍为
  `lark-lightweight`。这不会打开用户 preset 根、宿主任意路径或管理员配置写入。
- `full` profile 不加载 lightweight overlay，使用仓库的“飞书全功能模式”并恢复宿主本机
  执行组合；它与仓库的“全能优化模式”及官方 `standard`、`code`、`minimal`、`cordis`
  一起组成系统 preset roster；其中 `lark-lightweight` 不再限制工作区执行能力，执行型
  preset 仍由 full/OCI profile 的对应 provider 承载。
- OCI profile 同样不加载 lightweight overlay，继续暴露包含 `lark-lightweight`、`lark-standard`、
  `liangshen` 与官方四个 preset 的七项 system roster，且只扫描 system roots；执行边界由
  `dsh-sandbox-oci` 提供；full 与 OCI 的选择必须由 supervisor 显式设置并记录。
- 未知 preset 或 preset 依赖未激活时继续 fail loud。`lark-standard` 是保留的持久化 ID，
  当前展示名为“飞书全功能模式”，不是轻量兼容 alias；历史 header 因而无需改写即可恢复。
  用户目录 preset（包括历史 Liangshen 同步目录）仍不在 full/OCI roster 中；`liangshen`
  来自仓库 system root，避免静默改变权限边界。

官方 `dsh-web-app` 必须保留以下能力行：

| 能力域 | 官方组合 |
| --- | --- |
| Host / transport | `dsh-host-webserver`、`dsh-host-apiproxy`、`dsh-client-connection`、`dsh-client-runtime` |
| Chat / session | `dsh-client-ui-conversation`、会话列表、历史、prompt、cancel、事件流 |
| Work surface | `dsh-client-ui-workspace`、`dsh-client-ui-tool`、`dsh-client-ui-plan`、`dsh-client-ui-trajectory` |
| Automation / interaction | `dsh-client-ui-commands`、`dsh-client-ui-skill`、`dsh-client-ui-workflow-run`、`dsh-client-ui-user-questions` |
| Configuration / output | `dsh-client-ui-settings`、`dsh-client-ui-model-selection`、`dsh-client-ui-deliverables` |

`lark-approval` 只在 Web profile 中禁用，因为官方 `userQuestions` provider 已经
提供唯一的问题面板；飞书 profile 继续使用飞书专用 provider。此调整不删除审批能力，
只是避免同一 Cordis profile 注册两个 provider。

## 3 HTTP 与 WebSocket 契约

首页由官方静态 Host 提供，并包含 `window.__DSH_BOOT__` bootstrap 与官方 frontend
模块。浏览器 RPC 使用官方 `client-request` envelope：

```json
{
  "type": "client-request",
  "rpcId": "<client-generated-id>",
  "method": "<official-method>",
  "payload": { "args": {} }
}
```

请求路径是 `POST /api/<method>`，响应为 `server-response` envelope。常用会话方法
包括 `host.describe`、`session.list`、`session.history`、`session.prompt` 和
`session.cancel`；具体方法由官方 API descriptors 决定，不在本仓库复制一份平行路由表。

slash 命令必须使用官方生成的斜杠 RPC 路径，不能写成点号别名：

```text
POST /api/commands/list
POST /api/commands/execute
payload.args.agentId = <session id>
payload.args.line    = <complete command line>
```

官方只下行事件通道为 `/api/events.mux` 与 `/api/events.host`，通过 WebSocket 升级。
普通 HTTP 请求这些路径返回 `426 Upgrade Required` 并声明 `Upgrade: websocket`。
错误分两层：HTTP 层反映媒体类型、Host trust 和升级边界；业务层放在响应 envelope
的 `result.ok` / `result.error` 中。缺失 session 等业务错误可以是 HTTP 200，客户端必须
读取 envelope，不能只看 HTTP 状态。

协议硬门禁：JSON 不是 `application/json` 返回 415；不受信任 Host 返回 403；WebSocket
握手只允许官方 Host 路由；不得增加绕过 Host trust fence 的 `/api` 别名或开放 CORS。

认证账户面也保持官方 Web 外壳：`dsh-lark-web-auth` 向官方设置 ledger 注册
`settings.trigger` 和单一 `settings.section`“账户中心”，不向通用设置追加账户信息卡片。
头像入口和完整账号工作台都位于原生设置面板内；密码安全、飞书配对、用量额度以及管理员权限
作为账户中心内的可折叠平铺项，不占用设置根导航的多个位置；管理员项只在 `/auth/me` 返回
管理员角色时显示。旧 `/auth/account` 页面已移除，历史 URL 仅重定向到 `/`，避免维护第二套
账户 UI。账户中心共用 `--dsw-alias-*` 语义 token，默认跟随系统，并由官方设置面板保持原版
浅色/深色选择；该 UI 适配不改变 Worker 内部凭证、Scope、资源归属或沙箱策略。

## 4 进程、会话与同步

Web Host 与 `dsh-lark-run` 在同一个 Worker 进程内组合，共用 Cordis Context、Agent、
Session、SessionPersistence、workspace root 和 Scope 校验。不会为 Web 再启动第二个
Agent host。官方 Web 监听 `/api/*`，飞书/内部运行面继续监听既有 `/v1/*`；端口由部署
配置决定，隔离验证 overlay 只把 `lark-run` 改为 OS 随机端口。

Web 和飞书的“同步记录”以持久化 session 为准，不以 UI 展示或相同 prompt 猜测。新建 Web
session 默认独立；只有用户在当前 Web agent 内执行 `/lark-share`，再从飞书执行
`/session claim <code>`，才能把该 session 授权给当前完整 Scope。具体授权、目录和生命周期
见 [session-directory.md](session-directory.md)。

- `/lark-share` handler 使用官方命令 invocation 中的准确 agent/session id，不从浏览器字段、
  cwd、标题或最近活动会话猜测目标；
- claim code 短期且一次性，Worker 只保存摘要与状态；受 rc.7 官方命令生命周期契约约束，
  返回明文会写入发起者自己的 `command/done`，但不进入目录文件、Gateway 日志或卡片载荷；
- claim 成功后 Web 与飞书使用同一个持久化 session log；飞书 borrowed live agent 或按 header
  的真实 cwd/preset 冷恢复，不改写 Web workspace；
- 飞书只可 `list/use/run` 当前完整 Scope + generation 已 claim 的会话；知道 sessionId 不构成
  授权，Web 也不会自动暴露其他 tenant、bot、deployment、user 或 conversation 的绑定；
- 同一 session 的模型可见内容必须能从 session log 重建，新增输入同时落盘。

## 5 配置与安全

官方 `dsh-web-app` 配置仍以可校验 Config 为准：

```ts
interface Config {
  printUrl: boolean;
  surfaceContext: boolean;
  trustedHosts: string[];
}
```

部署层还必须明确 Web Host 的 loopback host、端口、请求体限制、可信 Host authorities
和 session persistence root；非法值在启动时 fail loud。默认只绑定 `127.0.0.1`，不把
Worker Bearer token、`.env` 值、完整 Scope 或内部凭证注入浏览器。当前官方 `/api` 没有
独立产品登录层，因此非 loopback 暴露前必须另立认证 SPEC，不能靠隐藏 URL 或前端字段
伪造安全性。

飞书 Gateway 进程绝不执行工作区工具；Web 的执行能力只存在于 Worker。知识检索 ACL
必须在查询内过滤；技能、工具、附件和交付物仍遵守各自 SPEC 的信任与 Scope 边界。

## 6 行为与测试契约

必须覆盖以下无密钥回归：

- 静态组合检查 Worker manifest、官方 Host/client roster、persona 和 provider 唯一性；
- 静态组合检查三个第三方发布版本、聚合包中的 sidebar 唯一挂载、Gateway 隔离与原生构建 allowlist；
- 首页 bootstrap、点号 RPC envelope、命令 `commands/list` / `commands/execute`；
- 415 媒体类型、403 Host trust、426 WebSocket 升级和两个事件通道；
- session history/prompt/cancel 的路由与缺失会话错误；
- `/v1/healthz`、`/v1/session-overview` 与官方 `/api` 在同一隔离 Worker 的共存；
- Web `/lark-share` 只分享 invocation 对应 session，未 claim 的 Web session 不进入飞书列表；
- claim 后 Web/飞书接续同一历史，borrowed agent 不被飞书释放，冷恢复保留模型与 preset；
- lightweight 下工作区选择、新会话创建与 `commands/list` 成功，且会话工具目录不出现
  shell、`tool-fs-search`、jobs 或委派执行能力；
- 不发送真实飞书消息，不调用真实模型、Firecrawl、邮件或生产外部服务。

真实构建产物必须在独立 Brave 调试实例检查 1440x900、768x1024、390x844：页面无水平
溢出，聊天输入、会话切换、slash 命令入口、设置、Context tab、第三方扩展入口、皮肤和
better-sidebar 桌面/移动布局可观察。截图与 live
协议结果归档到 [dsh-web-protocol-20260817.md](../evidence/dsh-web-protocol-20260817.md)。

## 7 迁移与行为变化

DSH 0.1.5 的自有 persona 配置使用 `prefix`，部署 SystemPrompt 使用 `personaPrefix`；全能优化模式从官方导出的 prefix/suffix section 名称识别人设，提升后通过 `presentAs('ptc')` 选择工具呈现。保持原提示词正文、Scope及OCI策略不变。回归必须以安装版本的公开 schema 校验预设，不允许只用旧字段字符串断言作为兼容证据。Worker `--boot-check` 必须逐个调用官方 `standingKeyFor` 挂载所有可发现预设，并在finally释放Context；Linux发布门禁覆盖lightweight/full/OCI三组合。检查不创建会话、不调用模型或执行工具。

旧版仅 dashboard/conversations/knowledge 的 admin-first 说明不再是聊天 Web 的实现
基线；它描述的能力归 [admin.md](admin.md) 管理面所有。官方 Web 采用后：

| 来源 | 当前处置 |
| --- | --- |
| 旧 `webui.md` admin-only 目标 | 由本 SPEC 替换为官方聊天 Web；历史证据保留并标记为 superseded。 |
| `apps/admin-web` | 保留独立 `/admin/*` 管理控制面，不承载聊天，不限制 Worker Web。 |
| `@deepseek-ai/dsh-web` | 保留为 Web capability definition；不把它误写成 frontend。 |
| `@deepseek-ai/dsh-web-app` | 作为 Worker 的官方 Web Host/frontend 基线，精确锁定版本。 |
| `dsh-lark-web-bundle` | 只做部署覆盖，不复制或重实现官方 UI。 |
| 官方 `standard`、`code`、`minimal`、`cordis` preset | 仅 full/OCI Worker profile 暴露；生产 Auth Edge 允许普通用户选择包含轻量模式在内的七项 system-only roster，不改变 lightweight 默认值。 |
| `lark-lightweight` preset | 新增与默认 lightweight 宿主能力匹配的只读/文件工作区 agent 组合，避免挂载等待已禁用服务的工具。 |
| `lark-standard` preset | 保留持久化 ID，展示名为“飞书全功能模式”，在 full/OCI profile 复用官方 `standard` 组合。 |
| `dsh-context@0.25.3` | 新增上下文占用、演化与消息构成的 Web 可视化和 `/context` 命令。 |
| `@linxin666/dsh-web-all@0.3.6` | 安装第三方 Web 工作台与皮肤；由本地政策显式禁用不符合不可变发布、Scope、凭证、认证或平台 preset 边界的子行。 |
| `dsh-better-sidebar@0.15.2` | 由聚合包唯一挂载，lightweight 禁用、full/OCI 可激活；不单独追加第二个 bundle 行。 |

任何新增 UI、RPC、事件或跨 Scope 映射都必须先更新本 SPEC 和对应官方/本地 contract，
再实施并补可无密钥重放的快照或协议测试。

## 8 开放问题

当前未解决的问题只有部署选择：如果需要把 loopback Web 安全暴露到局域网或公网，必须
单独选择官方兼容的认证、TLS、Origin/Host allowlist 和审计方案；在此之前不得扩大
`trustedHosts` 或将 `/api` 绑定到非 loopback。
