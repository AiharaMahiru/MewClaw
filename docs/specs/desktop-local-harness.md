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

2026-09-11 用户现场反馈本地 UI 与云端不一致。桌面官方依赖统一为当前 Web 的 0.1.6-alpha.2，使用与云端相同的 main/rightbar 布局契约，取消本地 legacy conversation/details 分支。升级仍不得修改官方包；完成编译、页面错误采集和运行时完整性验证后才交付。

2026-09-10 用户确认：本地 Harness 在电脑运行，继续使用云端账号和模型。左侧栏底部提供云端/本地切换，切换整套会话列表。打开本地目录不依赖云端 desktop-workspace。此契约取代 desktop-workspace.md 中桌面主界面的桥接切换约定；旧桥接保留供已有云端绑定使用，不迁移其会话。

不修改官方 DSH 包与社区子模块；不自动部署云端或复制服务端密钥。复用官方本地 Harness，不重写 Agent 与日志系统。复用 Web 品牌插件；编辑器与 Markdown 构建/测试依赖按官方版本要求精确补齐，不修改官方包规避依赖。

## 2 服务契约

SessionLocation 为 cloud | local。Host 进程持有可变 location，HTTP 与 WebSocket 每次请求读取当前值，禁止单个请求在处理中改变路由目的地。切换保存偏好并等待进程内能力变更完成后，返回 reload 标记，由 renderer 刷新当前页面；不调用 Electron app.relaunch()/app.quit()，也不调用 DesktopRuntime.requestRestart()。准备失败恢复偏好，当前 WebServer 继续服务。

刷新以无缝过渡面呈现：旧 renderer 先写入切换意图（目标位置与当前页面计算背景/前景色）并在当前页盖同色覆盖层，再触发整页重载；新文档解析期由注入 BootGraph 前置脚本的自包含运行时重建同一过渡面，#root 出现内容后淡出。全程窗口无白闪，Electron 进程、会话分区与其他窗口不变。意图仅存于 sessionStorage，读取即清除；无 BootGraph 页面（如登录页）负责清除遗留意图。过渡面是增强行为，缺失或失败不得阻断启动。

GET /api/mewclaw-desktop/location 返回 {location}。POST 只接受 {location}；必须通过本机 connection 授权与同源校验。写入失败返回 LOCATION_SAVE_FAILED；非法值返回 INVALID_LOCATION；切换期间拒绝重复操作。

## 3 配置契约

模式偏好保存于 DSH_HOME 下 mewclaw-location.json，首次 cloud。切换保存成功后仅刷新当前 renderer（重载在过渡面遮蔽下完成），Electron 进程、WebServer 和已打开的其他窗口不重启；配置损坏明确启动失败。cloudOrigin 继续使用既有 HTTPS 验证。目录大小、条数等限制继续使用既有 Config。

## 4 事件契约

本地模型输入与工具结果由官方 session 事件持久化；不隐藏注入文件内容。模式偏好在当前进程保存后立即影响下一次页面加载，不是模型可见输入。

## 5 模型可见面

本地会话复用与 Web 同版本的官方 Agent preset、文件工具、Shell、Skills、计划、目标、子代理及工作流；移除本地专用 desktop_workspace 工具和工具目录收窄。官方工作区选择器登记本机工作区，官方工具经本机 FileSystem/subprocess 与权限 preset 执行，模型输入及工具结果仍由官方日志承载。旧云端 workspace HTTP 控制面在本地模式返回 409；不自动同步文件。目录 cwd 不构成沙箱，本机命令以当前系统账号权限运行。

工作区属于当前 OS 用户的本地 Host；不宣称云端账号级隔离。官方工作区登记和历史会话在关闭、登出和模式切换后保留，恢复规则与官方 Web 一致。本地目录通过同一“选择工作区/添加工作区 → 浏览/编辑路径 → 打开”流程选择，不提供独立目录按钮。

旧 LocalWorkspaceFiles 帮助类仅保留已有文件桥接的版本化读写验证，不替代模型侧官方文件工具。该旧桥接临时授权在登出/切换时撤销；目录选择或登记未完成时发生撤销，旧桥接操作必须返回 `LOCAL_WORKSPACE_AUTHORIZATION_REVOKED`，不得恢复授权；Windows 按大小写不敏感的规范路径匹配。

## 6 行为契约

云端会话始终使用云端 API，本地会话始终使用本机 API。模式切换不迁移、同步或合并会话。目录选择与本地日志浏览不要求云端工作区服务。

切换只改变会话列表、会话与工作区；账号级配置（`/auth/models` 账号模型管理、`dsh-web-ui-settings` 远程偏好）在两种模式下读写同一份云端状态，localStorage 界面偏好同源共享。`/api/settings`、`/api/llm`、`/api/credentials` 属 Harness 作用域，本机模式下管理本机 Harness，不转发云端（云端的同名面指向共享部署配置，且官方已从云端 BootGraph 剔除设置面板）。

模型推理仍需网络与有效云端账号。云端模型配置与默认模型由 Auth Edge 作为唯一权威，本地桌面只通过当前账号 Cookie/CSRF 调用固定的云端推理桥接；API Key 永不同步到桌面或本机存储。不存在已部署推理入口时明确显示模型服务不可用，不索取 Worker token 或使用网页登录态冒充上游 API Key。

本地会话的云端模型桥接使用云端 Cookie/CSRF 调用 POST /auth/desktop-inference/chat/completions，`model` 字段透传服务端路由选择器（`auth.md` §6：`cloud-default` / `account/<profileId>[/<model>]` / `shared/<provider>/<model>`）。Edge 使用已认证 userId 在服务端解析路由与密钥并代理 SSE；上游 API Key 仅在服务器请求期间使用，禁止重定向和透传错误正文。使用现有用户限流及 PromptAuditor；审计不可用拒绝请求。AUTH_DESKTOP_INFERENCE_TIMEOUT_MS 默认 120000，范围 1000–600000，客户端断开取消上游。

本地 picker 的模型目录由 `mewclaw-cloud` 桥接适配器从 `/auth/models` 展开，**provider 布局与云端 Worker 同构**：`web-private`（"我的模型"，仅列默认 profile 的 `defaultModel`——云端私有路由只解析默认项）+ 每个 `sharedModels[].provider` 同名 provider（列该 provider 的模型，原始 model id + 服务端 name）。会话持久化的 `(provider, model)` 与云端完全一致（如 `web-private/<model>`、`deepseek-official/<model>`），桥接层在推理时映射为服务端选择器（`cloud-default` / `shared/<provider>/<model>`）透传。适配器通过 `AdapterRegistrationHandle.replace` 在目录到达后原子换路由；与本地既有 provider 冲突时按下段提供桥接回退。旧版 `mewclaw-cloud/*` 持久化选择仍兼容解析（含 `account/<pid>[/<model>]` 与 `shared/...` 形态），该 provider 仅列冲突回退条目。未知选择器不发推理请求；目录缓存 5s，`/auth/models` 非 GET 请求后失效。本机不保存供应商密钥。云端模式的原有模型选择不变。

共享或私有 provider 与本机既有适配器同名时，不覆盖本机注册；冲突条目改列在 `mewclaw-cloud` 下，以 `shared/<provider>/<model>` 或 `cloud-default` 为 id。默认选择必须引用桥接实际持有的路由；冲突回退保留模型的 reasoning 元数据。无冲突时维持云端同形目录。

### 6.1 Web 组件一致性（2026-09-23）

桌面本地使用与 Web 同一官方依赖版本、同一自有插件 client、同一 agent preset 文件；候选准备从 Web bundle 政策生成桌面 UI 组合，启用的第三方组件版本从 Worker manifest 读取。账号中心、远程界面设置、模型位及思考强度滑条、液态玻璃、品牌、模式/权限选择等均复用现有组件和公开 slots/ModelDirectory；不得以 CSS 仿制功能。仅桌面宿主控件、目录 provider和本机工具 provider 按平台适配。未启用的第三方市场等维持 Web 的有效策略。

位置切换在侧栏公开 footer slot 呈现带 SVG 图标的分段按钮；选中状态同时有文字、底面和 aria-pressed，折叠侧栏保留可区分图标。颜色、边框、悬停、按下与焦点使用 MEWCLAW/官方语义 token；处理中阻止重复提交，错误就地显示。过渡面沿用当前主题并遵循 prefers-reduced-motion。

过渡面必须使用不透明纯色：先读取 body，再读取根元素底色；透明或半透明色回落到默认底色，避免官方启动画面透出并与切换文案叠影。重载前后的覆盖层遵守相同规则。

本机 AgentPresets Provider 继承官方实现，仅覆盖 remoteExportList 的可见名单及显示名称；配置在候选准备时从 Auth Edge 的模式政策生成，发现、挂载、切换与日志仍由官方实现承担。UI 策略依次应用 Web bundle 与 full overlay，启用 Git、任务板、技能等有效组件并停用重复文件树及插件管理页。

桌面生成的历史模式 wrapper 使用官方 Include 的 Provider 子类，通过 Node 包解析和官方 `package.json` 导出定位 standard preset，不依赖 workspace 链接或发行包的目录深度。Include 的组配置不展开 `!!js`，因此路径解析由该 Provider 构造配置；官方 preset 保持原文件，开发与安装布局均须实际挂载可见模式。

桌面首屏 BootGraph 与 `/plugins/events` 的 graph 快照必须经过相同组合：本地由公开 clientModules 服务提供图及重建事件，云端在流式代理边界转换图。动态更新不能撤销桌面位置、账号或品牌 Provider，也不能重新启用被 Web 政策禁用的客户端；重建事件、心跳、断开与 disposer 保持官方语义。

## 7 安全与信任

桌面控制面仅 loopback、Desktop Renderer 能力与官方 connection 授权。上游 API Key、worker token 不下发桌面。本机官方工具遵循本机权限 preset 与宿主能力；原生文件桥接仍拒绝越界、撤销、过期授权。云端模型可看到请求中实际发送的内容。

## 8 测试契约

Windows 发行使用 `asar:false` 的物理目录，并关闭仅允许 ASAR 的 Electron fuse。官方 FileSystem 使用 BigInt stat，Electron ASAR 虚拟 stat 返回 number 会破坏目录读取；采用打包配置避开该不兼容，不修改官方包或全局 fs。原生 ripgrep 仍在发行的 extraResources，冒烟精确核对该路径并执行实际 spawn。

unit/security：非法模式、损坏偏好、写入失败、重复切换、未授权控制面；cloud↔local 双向切换不调用 Electron 退出/重启 API，renderer 刷新后收到新的位置 BootGraph，固定模式下 HTTP/WS 路由不变。过渡面 unit：无意图静默、有意图解析期铺开且 #root 就绪后淡出、意图损坏/非法颜色回落默认、登录页清除遗留意图。文件工具覆盖越界、版本冲突、撤销。snapshot/e2e：欢迎页及会话页侧栏开关，切换列表、本地目录取消/选择、页面刷新后会话恢复。Release 构建和真实模型验收分别报告。

## 9 迁移映射

行为变化（2026-09-23）：本地模式从受限文件工具模式升级为同一 Web 组件和 preset 的本机 Harness；模型工具不再收窄为 desktop_workspace。依赖升级到 Web 的 0.1.6-alpha.2，仅候选，旧安装与生产不变。

旧会话标题栏切换改为侧栏全局会话位置切换；本地模式不再调用云端 bind/poll/result。云端既有会话原地保留。桌面候选与 Web 独立交付，不自动合并或切换生产。

行为变化（2026-09-14）：位置切换的 renderer 刷新由裸 location.reload() 改为过渡面遮蔽的无缝重载；服务端契约（POST 返回 reload 标记）与页面生命周期不变，仅消除切换期间的白闪。

## 10 开放问题

1. 2026-09-23 已确认生产 R81 提供推理接口；Desktop 与 TUI 的本机官方引擎组合均完成真实账号模型文件读写，证据见 `docs/evidence/20260923-local-client-workspaces.md`。
2. Windows 物理主机上的安装交互、盘符/UNC 目录浏览与终端仍需实机验收；Linux Electron 与 Wine 证据分别记录。
