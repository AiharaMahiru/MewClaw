# 桌面端云端配置同步契约

桌面端的账号、会话、模型目录和远程设置以云端为权威。桌面 CloudProxy 只转发认证后的 HTTP、SSE 与 WebSocket 请求，固定到 `cloudOrigin`；`/api/dsh-web-ui-settings/describe`、`/auth/models`、提供方目录和 Agent Preset 等请求保持原路径，不在本机复制数据库或 JSONL。

同步边界按作用域划分：`/auth/models`、`/auth/*` 与 `dsh-web-ui-settings` 是账号作用域（Auth Edge 按用户解析），本地模式原路径转发；`/api/settings`、`/api/llm`、`/api/credentials` 等 `/api/*` 是 Harness 作用域——在云端它们指向共享部署的管理配置而非账号配置（官方还在云端把 `dsh-client-ui-settings` 从 BootGraph 剔除），本机模式下管理本机 Harness，必须留在本机。会话、工作区、`session/modelCatalog`（经本机云端账号模型桥接适配器解析）同样由本机 Harness 服务。

模型/API key 由 Auth Edge 和 Worker 在云端保存与使用。桌面只接收 `keyConfigured`、提供方状态和模型元数据，禁止把真实 key 写入 Electron userData、localStorage、启动清单或日志。普通账号的 settings mutate 继续由云端权限策略控制，桌面不能绕过管理员边界。

登录或切换账号时，云端注入的账号标识会清理浏览器级会话与工作区键，避免旧账号状态串入新账号。云端断线时桌面显示配置不可用并停止依赖远程设置的操作，不回退到旧账号或随机本地凭证。

本地工作区、Shell 和目录同步属于桌面插件的本机能力，授权、撤销和路径仍由宿主控制；它们与云端配置同步是两条独立链路。
