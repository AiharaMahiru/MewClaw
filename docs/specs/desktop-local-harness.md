# 桌面本地 Harness SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | dsh-lark-desktop-cloud |
| 位置 | apps/desktop/plugins/cloud |
| 角色 | Definition / Provider / Consumer |
| 状态 | implementing |
| 里程碑 | Desktop 2 |
| 关联 ADR | ADR-1、ADR-3 |
| 依赖能力 | 官方 Agent、Session、FileSystem、WebServer、Cordis；原生 DesktopRuntime |
| 提供能力 | 独立本地会话与云端会话切换 |

## 1 目的与边界

2026-09-11 用户现场反馈本地 UI 与云端不一致。桌面官方依赖统一为 0.1.5-rc.2，使用与云端相同的 main/rightbar 布局契约，取消本地 legacy conversation/details 分支。升级仍不得修改官方包；完成编译、页面错误采集和运行时完整性验证后才交付。

2026-09-10 用户确认：本地 Harness 在电脑运行，继续使用云端账号和模型。左侧栏品牌下方、新建会话上方提供云端/本地切换，切换整套会话列表。打开本地目录不依赖云端 desktop-workspace。此契约取代 desktop-workspace.md 中桌面主界面的桥接切换约定；旧桥接保留供已有云端绑定使用，不迁移其会话。

不修改官方 DSH 包与社区子模块；不自动部署云端或复制服务端密钥。复用官方本地 Harness，不重写 Agent 与日志系统。复用 Web 品牌插件；编辑器与 Markdown 构建/测试依赖按官方版本要求精确补齐，不修改官方包规避依赖。

## 2 服务契约

SessionLocation 为 cloud | local。Host 进程持有可变 location，HTTP 与 WebSocket 每次请求读取当前值，禁止单个请求在处理中改变路由目的地。切换保存偏好并等待进程内能力变更完成后，返回 reload 标记，由 renderer 刷新当前页面；不调用 Electron app.relaunch()/app.quit()，也不调用 DesktopRuntime.requestRestart()。准备失败恢复偏好，当前 WebServer 继续服务。

GET /api/mewclaw-desktop/location 返回 {location}。POST 只接受 {location}；必须通过本机 connection 授权与同源校验。写入失败返回 LOCATION_SAVE_FAILED；非法值返回 INVALID_LOCATION；切换期间拒绝重复操作。

## 3 配置契约

模式偏好保存于 DSH_HOME 下 mewclaw-location.json，首次 cloud。切换保存成功后仅刷新当前 renderer，Electron 进程、WebServer 和已打开的其他窗口不重启；配置损坏明确启动失败。cloudOrigin 继续使用既有 HTTPS 验证。目录大小、条数等限制继续使用既有 Config。

## 4 事件契约

本地模型输入与工具结果由官方 session 事件持久化；不隐藏注入文件内容。模式偏好在当前进程保存后立即影响下一次页面加载，不是模型可见输入。

## 5 模型可见面

本地文件能力复用 LocalWorkspaceFiles 与官方 FileSystem。用户通过原生目录选择授权，普通网页路径不能授予权限。本地模式仅允许 desktop_workspace 文件工具，Agent 创建时收窄工具目录并以全局 guard 拒绝其他工具。旧云端 workspace HTTP 控制面在本地模式返回 409；Shell、子代理及同步不在本地模式开放。目录 cwd 不构成沙箱。

授权属于当前 OS 用户的本地 Host 和规范化目录，同一目录的本地会话共享授权；不宣称云端账号级隔离。授权不落盘，退出登录、关闭或切换后需重新选择目录。本地历史会话保留。

## 6 行为契约

云端会话始终使用云端 API，本地会话始终使用本机 API。模式切换不迁移、同步或合并会话。目录选择与本地日志浏览不要求云端工作区服务。

模型推理仍需网络与有效云端账号。云端模型配置与默认模型由 Auth Edge 作为唯一权威，本地桌面只通过当前账号 Cookie/CSRF 调用固定的云端推理桥接；API Key 永不同步到桌面或本机存储。不存在已部署推理入口时明确显示模型服务不可用，不索取 Worker token 或使用网页登录态冒充上游 API Key。

本地会话的云端模型桥接使用云端 Cookie/CSRF 调用 POST /auth/desktop-inference/chat/completions，传输模型占位符 cloud-default。Edge 使用已认证 userId 解析账号私有默认模型和加密 API Key，校验公网地址并代理 SSE；上游 API Key 仅在服务器请求期间使用，禁止重定向和透传错误正文。使用现有用户限流及 PromptAuditor；审计不可用拒绝请求。AUTH_DESKTOP_INFERENCE_TIMEOUT_MS 默认 120000，范围 1000–600000，客户端断开取消上游。

当前仅支持账号已配置的默认私有模型，不包含服务器共享模型回退、共享额度计费、动态上下文窗口或多模态。未配置私有默认模型时返回 CLOUD_DEFAULT_MODEL_REQUIRED。云端模式的原有模型选择不变。本机保存模型别名，不保存供应商密钥。

## 7 安全与信任

桌面控制面仅 loopback、原生 Renderer 能力与官方 connection 授权。上游 API Key、worker token 不下发桌面。文件根来自原生授权；越界、撤销、过期授权拒绝执行。云端模型可看到请求中实际发送的内容。

## 8 测试契约

unit/security：非法模式、损坏偏好、写入失败、重复切换、未授权控制面；cloud↔local 双向切换不调用 Electron 退出/重启 API，renderer 刷新后收到新的位置 BootGraph，固定模式下 HTTP/WS 路由不变。文件工具覆盖越界、版本冲突、撤销。snapshot/e2e：欢迎页及会话页侧栏开关，切换列表、本地目录取消/选择、页面刷新后会话恢复。Release 构建和真实模型验收分别报告。

## 9 迁移映射

旧会话标题栏切换改为侧栏全局会话位置切换；本地模式不再调用云端 bind/poll/result。云端既有会话原地保留。本机本轮只改 desktop-dev；服务端推理接口另行交接，不合并整条桌面分支到 master。

## 10 开放问题

1. 新 Auth Edge 推理接口已实现并有无密钥回归，但尚未部署生产；真实账号与模型调用仍需管理员部署后验收。
2. 真实原生目录选择、页面刷新后旧会话重新授权与模型驱动文件读写，需要实机人工验收；Release 页面冒烟不能替代该链路。
