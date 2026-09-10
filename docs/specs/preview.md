# dsh-preview 公共 Web/API 分享能力 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-preview` + `dsh-tool-preview` + `dsh-preview-app` + `skills/lark-share` |
| 位置 | `packages/preview/preview`、`packages/preview/tool-preview`、`apps/preview`、`skills/lark-share` |
| 角色 | Definition + Client Provider + Preview App + Tool Consumer + Skill |
| 里程碑 | M9 |
| 状态 | implemented |
| 关联 ADR | ADR-2、ADR-4、ADR-6、ADR-8、ADR-10 |
| 依赖能力 | `ctx.credentials`、`ctx.tools`、`ctx.systemPrompt`、`ctx.larkScopeIndex` |
| 提供能力 | `ctx.preview`、`/share/<id>`、`share_web`、`share_list`、`share_revoke` |

## 1 目的与边界

为所有已认证 DSH 用户提供可撤销、可过期的 HTTPS Web/API 分享：模型可在当前
Scope 工作区内启动任意语言的 HTTP 服务，并返回
`https://chat.rwr.ink/share/<id>/`。公开访问只经过现有 TLS 入口、Auth Edge 和
独立 loopback Preview 服务，不向公网开放用户端口。

非目标：不暴露 Worker/Auth/Admin/Gateway/PostgreSQL 控制面端口；不提供任意上游
URL 代理；不允许模型指定所有者或宿主路径；不改变主 Agent OCI 的
`network: none`；不把分享 ID 当作账户授权凭证。

## 2 服务契约

```ts
interface PreviewService {
  publish(input: {
    scope: Scope;
    workspace: string;
    command: string;
    port: number;
    ttlMinutes?: number;
  }): Promise<PreviewDescriptor>;
  list(scope: Scope): Promise<readonly PreviewDescriptor[]>;
  revoke(scope: Scope, id: string): Promise<void>;
  dispose(): Promise<void>;
}
```

Worker 中的 Provider 是携带内部凭证的 typed HTTP client；Preview App 必须再次校验
真实工作区包含关系和 per-user 配额，再启动独立 rootless Podman 容器。容器以随机名称、非 root 用户、只读根、cap-drop、
no-new-privileges、CPU/内存/PID/tmpfs 上限和 `network=none` 运行。用户命令仅在
容器内由 Bash 解释。公开请求通过按连接创建的 `podman exec` 字节桥访问容器内
`127.0.0.1:<port>`，不映射宿主 TCP 端口。Preview App 只监听
`127.0.0.1:13082`，Auth Edge 是唯一公网 Consumer。

Linux systemd 运行时必须直接使用 `/run/user/<dsh uid>` 的 XDG runtime 与 user bus，
确保 rootless Podman 将 CPU、内存和 PID 受限容器创建在用户 manager 的 delegated cgroup；
不得通过非标准 runtime 别名启动 Preview Podman。unit 对 home 目录保持只读，仅将 DSH 状态根
与自身 user runtime 标为可写；地址族除 HTTP 所需项外只增加 rootless Podman 所需的
`AF_NETLINK`，不改变 Preview 容器的 `network=none`。

错误分类：`PREVIEW_INVALID_INPUT`（调用方输入）、`PREVIEW_FORBIDDEN`
（Scope/路径/所有权）、`PREVIEW_QUOTA`（用户上限）、`PREVIEW_UNAVAILABLE`
（Podman/镜像/端口未就绪）、`PREVIEW_NOT_FOUND`（未知或已过期）、
`PREVIEW_UPSTREAM`（用户服务失败）。

生命周期：Provider 激活时清理带本能力专用 label 的孤儿容器；每条分享到期或撤销
即强制回收；Worker dispose 时只清理由当前实例创建的 preview 容器。

## 3 配置契约

```ts
interface Config {
  previewBaseUrl: string;      // Client 默认 http://127.0.0.1:13082
  tokenEnv: string;            // Client/App 复用 WORKER_TOKEN 凭证引用
  publicBaseUrl: string;       // App 默认 https://chat.rwr.ink
  workspaceRoot: string;       // 必须为绝对路径
  image: string;               // 必须显式配置并锁定生产镜像
  podmanPath?: string;         // 默认 podman
  defaultTtlMinutes?: number;  // 默认 60，范围 1..1440
  maxTtlMinutes?: number;      // 默认 1440，范围 1..10080
  maxSharesPerUser?: number;   // 默认 3，范围 1..20
  startupTimeoutMs?: number;   // 默认 15000，范围 1000..60000
  requestTimeoutMs?: number;   // 默认 30000，范围 1000..120000
  maxConcurrentRequests?: number; // 默认 64，范围 1..512
  maxRequestBytes?: number;    // 默认 10 MiB，范围 1 KiB..50 MiB
  resources?: { cpus: number; memoryMiB: number; pids: number; tmpfsMiB: number };
}
```

字段只在 `undefined` 时取默认；显式空值、非安全整数和越界值启动时 fail loud。
不新增密钥，内部认证复用既有 `WORKER_TOKEN` 凭证引用且不得输出。公网 URL 只允许
HTTPS 且不得含 query/hash/凭证。

## 4 事件契约

发布结构化审计事件 `preview/created`、`preview/revoked`、`preview/expired`，载荷只含
share ID、Scope 用户 ID、时间和原因，不含命令、路径、请求内容或响应正文。事件为
至多一次审计信号；独立 Preview App 写入脱敏结构化日志。消费事件：无。

## 5 模型可见面

- `share_web(command, port, ttl_minutes?)`：在当前会话工作区启动分享；有容器与公网
  副作用，返回 ID、URL、过期时间。
- `share_list()`：只列当前 Scope 用户的有效分享。
- `share_revoke(id)`：只撤销当前 Scope 用户拥有的分享。

工具参数不包含 Scope、用户 ID、绝对工作区、镜像、宿主、代理 URL或宿主端口。
Scope 仅由 `requireLarkRunScope` 获取，工作区仅取 `session.header.cwd`。工具调用与
结果由标准 tool session 事件落盘，满足“模型可见等于已落盘”。系统提示只说明
分享工具的适用场景和安全边界。

## 6 行为契约

- share ID 使用至少 128 bit CSPRNG，不编码用户或路径；未知、过期、已撤销均返回 404。
- 同一用户最多 `maxSharesPerUser` 条；到期计时和请求并发均有界。
- `/share/<id>` 允许除 `CONNECT`/`TRACE` 外的 HTTP/API 方法，去除分享前缀后转发；
  补充 `X-Forwarded-Prefix`，重写同源 Location、
  Cookie Path 与 HTML 根路径资源，并注入同源 fetch/WebSocket/EventSource 前缀适配。
- 请求不得把内部 Authorization、Cookie、`x-dsh-*` 或代理凭证转发给用户服务；响应
  不得覆盖平台 CSP/HSTS，也不得把容器内部地址暴露到 Location。
- HTTP 方法与正文保持；WebSocket 通过固定升级端点和不可伪造的 share ID 转接。

失败模式：Podman 不可用、镜像缺失、端口未监听、命令退出均 fail loud 且回收容器；
超时返回 504；请求过大返回 413；上游断开返回 502；回收失败记录不含命令/路径的审计
告警并有界重试。
Preview 是 Auth Edge 的可选依赖：systemd 只能用 `Wants` 和启动顺序关联，禁止用
`Requires`。Preview 启动失败或自动重启时，既有登录、API 和 WebSocket 必须继续可用，
只有 `/share/` 能力按确定的不可用错误降级。
控制请求失败只允许记录路由类别与错误码，不得记录命令、工作区、请求正文或凭证。

## 7 安全与信任

浏览器请求、share ID、模型命令和用户工作区均不可信。Preview App 对配置根和 cwd 做
`resolve` + `realpath` 双重包含校验并拒绝符号链接逃逸。模型不能选择宿主地址、控制面
端口或其他用户工作区。Auth Edge 只对 `/share/` 匿名转发，并仍用内部凭证访问
loopback Worker；其他页面与 API 登录边界不变。

容器必须保持 `network=none`，仅挂载当前工作区；不注入 `.env`、DSH 配置、宿主环境或
任何凭证。Nginx、Auth、Worker、Admin、Gateway 和 PostgreSQL 端口永远不是分享目标。
Auth Edge 必须在平台登录和 CSRF 判断前分流 `/share/`，移除平台 Cookie、
Authorization、Scope 与身份头，再用内部凭证代理到 Preview App；用户应用自行承担其
公开 API 的 Origin/CSRF 语义，且拿不到 DSH 登录 Cookie。

## 8 测试契约

- `unit`：配置、ID、TTL、配额、所有权、路径包含、头过滤、URL/HTML 重写。
- `security`：跨用户撤销拒绝、路径逃逸拒绝、控制头不透传、未知/过期统一 404。
- `e2e`：真实 Podman `network=none`；Node/Python/React 静态站、JSON API、WebSocket；
  撤销/到期后不可访问且零容器残留。
- `linux`：release 包含插件、技能和 `dsh-preview.service`；Preview/Worker 仍仅 loopback；公网 HTTPS 分享成功；
  控制面监听、OCI network、systemd 权限门禁不变。

无 Podman 的测试环境跳过真实容器 e2e，但单元/安全测试不得跳过。

## 9 迁移映射

无 lark-claw 来源，本能力为用户明确要求的新插件缝。既有第三方 remote-web 插件仍保持
禁用；它用于远程控制 DSH UI，不是用户应用分享，不能复用其配对或 tunnel 权限。

## 10 开放问题

冷启动时必须先由专用 dsh-podman-ready oneshot 初始化 rootless Podman namespace，
再启动保留 NoNewPrivileges 的 Worker/Preview；受限服务不能首次运行 newuidmap/newgidmap。
只在初始化 unit 允许既有 setuid 辅助程序，主服务与工作区容器的权限、断网和挂载边界保持不变。

无阻塞开放问题。域名固定为 `chat.rwr.ink`，路由固定为 `/share/<id>`；默认 TTL、配额
和资源值由本 SPEC 定义，后续只能通过校验后的 Cordis Config 调整。
