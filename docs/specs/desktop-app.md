# MewClaw 桌面 APP SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | 桌面发行组合及后续自有接入插件 |
| 位置 | scripts/prepare-desktop-candidate.mjs；独立桌面候选 |
| 角色 | App / Bundle |
| 里程碑 | Desktop 1 |
| 状态 | implementing |
| 关联 ADR | ADR-1、ADR-3、ADR-6 |
| 依赖能力 | dsh-plugin-desktop、官方 DSH 0.1.2-rc.1 |
| 提供能力 | 候选构建与验收，不新增运行时服务 |

## 1 目的与边界

在独立目录复用社区 dsh-desktop，不修改官方 DSH 依赖。开发源码提供云端会话接入、本机工作区、独立授权的 Shell 与双向同步；源码验收不代表生产发布或 Windows 实机验收。不继承上游依赖补丁、社区市场或 Agents Anywhere 后端。

## 2 服务契约

候选准备脚本接受上游绝对路径和不存在的目标绝对路径，验证固定提交后复制桌面包并生成独立依赖清单。已有目标拒绝覆盖；失败候选保留用于诊断，不自动删除。

云端接入插件位于 apps/desktop/plugins/cloud，作为独立桌面构建的 workspace，不进入服务器 pnpm 依赖树。它继承社区 DesktopWebServer 的公开 Provider，在相同 WebServer 服务契约下将非桌面私有路由转发固定云端。Definition 为官方 WebServer，Provider 为本插件，Consumer 为现有桌面 launcher 和官方 Web 客户端；不替换已注册服务实例或修改其方法。CloudProxy.http(req,res)、upgrade(req,socket,head) 不存储 Cookie；dispose() 幂等终止所有当前传输。

## 3 配置契约

Node 24，DSH 0.1.2-rc.1，桌面源码固定 a1ddcda8e701a8490c619ce411ea8a3d6daa1453。先生成锁文件再冻结。市场与 AA 为可选插件，不进入候选依赖；不向安装包注入生产凭证。Electron 为桌面必需依赖，仅进入独立桌面构建，不增加服务器运行依赖。

云端 Provider Config 继承官方 WebServer Config，新增 cloudOrigin（默认 https://chat.rwr.ink，只允许无路径、无凭证的 HTTPS origin，测试允许回环 HTTP）及 cloudTimeoutMs（默认120000，范围1000至600000毫秒）。Config 装载时校验，变更需重新装载；无运行时更换上游。私有路由 /api/desktop/ 与 /api/mewclaw-desktop/ 仍由本地插件处理，其他 HTTP 与官方已注册 WebSocket 路由转发云端。

MewClaw 发行入口使用社区包 package.json 的 main 字段启动完整 launcher，设置独立应用数据目录和 MEWCLAW_DESKTOP_CLOUD=1。社区 profile 消费此配置选择自有 Provider，未启用时仍为原 DesktopWebServer。该配置接入是明确记录的社区桌面派生变更，不是官方包补丁；此阶段不宣称社区桌面零改动。

## 4 事件契约

桌面布局通过公开 slot 装载工作区开关，客户端只提交会话与模式。配套云端事件和授权契约见 desktop-workspace.md。

## 5 模型可见面

桌面不新增模型执行；配套云端 desktop_workspace、desktop_shell 工具及同步授权边界见 desktop-workspace.md。

## 6 行为契约

官方包从 registry 精确版本安装，不使用原仓库 resolutions/patch。社区桌面消费方对失效接口做最小兼容修改并逐项记录：删除 settingsNamespace 导入，命名空间直接传官方接口接受的字符串常量；不伪造官方导出。必须报告这是社区桌面派生版本，不能称桌面源码完全原样。此兼容修改只发生在候选桌面插件，原始上游检出保持不动。

失败路径：目标已存在则拒绝；上游提交不符则拒绝；缺依赖或类型错误停止门禁；没有完成构建及启动检查不得进入发布。

## 7 安全与信任

构建阶段无生产访问；接入阶段允许访问现有生产页面，不读取密钥文件或修改官方依赖。准备阶段禁用安装生命周期脚本，后续仅按实际需求运行已检查的构建入口。目录必须独立；保留 MIT 许可证与上游提交记录。

每次云端代理前保留社区 Desktop 浏览器标识与官方 Connection Host/Origin/Cookie 检查。启动 token 仅由本地 authorizeIndex 消费，token、窗口标识、设备私有请求头与本地 dsh-auth-* Cookie 均不得出站；保留云端原有 Cookie/CSRF 对。仅在本地信任检查通过后将 Origin/Referer 规范化为云端，禁止把代理作为绕过 Origin 的公开入口。云端 Cookie 保留 Secure/HttpOnly，不记录凭证。桌面仅为 dsh_session、__Host-dsh_session、dsh_csrf 中未声明 Max-Age/Expires 的会话 Cookie 补充 cloudSessionRetentionSeconds（默认2592000秒，整数范围0至2592000，0表示不补充）；交由 Electron 持久化分区保存，不另存密码或凭证文件。服务端显式有效期和删除指令原样保留，服务端仍校验过期与撤销。连接失败HTTP502；Provider退出HTTP503；不自动重放写操作或WebSocket消息。

### Windows 开发包

独立候选根目录通过 `apps/desktop/electron-builder.cjs` 配置生成 Windows x64 开发包，主入口固定为 MewClaw `launcher.mjs`，产品名为 MewClaw。安装程序为当前用户 NSIS 安装，便携版同时提供 ZIP 与启动 EXE；不发布到远端、不配置代码签名。生产依赖显式包含桌面包与云端 Provider，ASAR 只打包发行文件及生产依赖，不包含凭证、源码工作区或测试数据。ripgrep 的 win32-x64 平台包原样放入 `resources/node_modules` 并从 ASAR 排除，使官方依赖通过 Node 父目录解析得到可 spawn 的物理路径；社区烟雾接受该资源布局并实际执行二进制。其他原生二进制按 Electron ASAR 规则解包；打包后必须通过真实 Electron RunAsNode 的模块/原生依赖烟雾。开发包版本不代表全部桌面功能验收完成。

## 8 测试契约

候选准备拒绝覆盖并复制版本化 npm 锁文件；完整构建与类型检查；桌面公开 profile 的加载与卸载烟雾；官方依赖文件完整性；离线云端桥接到本机文件/Shell/同步。真实云端模型、Windows 产物构建与 Windows 实机验收分别记录。

## 9 迁移映射

复用社区桌面包源码；丢弃其官方包 patch 配置。settingsNamespace 调用迁移到字符串接口，行为等价。既有 Web、飞书和会话数据不迁移。

## 10 开放问题

1. 工作区 Provider 配置 workspaceMaxBytes 默认262144（1024–1048576），workspaceMaxEntries 默认500（1–2000）；目录只来自原生授权。
2. 三模式 Cordis 装卸载、Electron Cookie 重启与离线工作区链路已验证；云端配套部署和真实账号模型实机验收未完成。
