# Desktop 复用 Web 组件与本机工作区

本地模式只切换 Harness 与工作区所在位置。模型位/思考强度、账号中心、玻璃主题、模式和第三方 UI 从 Web 的源码及有效配置生成；目录入口留在官方工作区选择器。位置分段控件占据公开 sidebar.footer.action，使用语义 token、SVG、键盘焦点、忙碌状态与减少动画偏好。

官方 DSH 统一为 0.1.6-alpha.2，Cordis 4.0.2；官方包保持原样。社区 Desktop 的 Alpha API 消费适配只作用于隔离候选。Web 已评审的第三方补丁按锁文件版本幂等应用，拒绝官方包名。

首屏变换不能单独充当插件组合：官方 HMR 首次发送完整 Host 图，会撤销只加在 HTML 中的客户端及其 Provider。桌面在公开 WebServer/clientModules 边界给首屏和 graph SSE 应用同一组合；保留 rebuilt 通知、分片 UTF-8、连接中止和 disposer。云端 graph 遵循该次首屏的账号隐藏策略。

Include patch 的 name 是匹配断言，不能用来替换插件。自有 AgentPresets Provider 通过禁用官方行并插入新行挂载；只覆盖 remoteExportList 的显示投影，官方发现/挂载/切换/日志不变。名单与名称在准备阶段读取 Web 的既有策略，UI 政策顺序为 bundle 再 full overlay。

Include 的组配置不展开 `!!js`。历史模式 wrapper 通过官方 Include 的小型 Provider 子类按包导出定位 standard，避免四级相对路径只适配物理发行、却破坏 workspace 开发链接。四种模式已通过真实 Electron 页面挂载与稳定性检查；不能用菜单可见替代挂载成功。

Electron 固定为 44.0.0：Alpha 依赖的 node-addon-require-builtin 拒绝 43.3.0 指纹。Windows EXE 在 Wine 下通过原生 spawn、Provider、DSH/pnpm、技能和 headless CLI；847 个官方 JS 前后字节相同。ZIP 必须在 NSIS 生成后归档，以包含构建器加入的 elevate.exe；验包逐字节核对整个应用目录。

公开使用与验证摘要见 docs/client-local-workspaces.md；完整本机证据保留于忽略 Git 的 docs/evidence/20260923-desktop-web-parity.md。Linux Electron compatibility 的实际账号登录、40项UI roster、四类模式菜单、官方中文目录、滑条、主题及双按钮切换已通过。Windows/macOS 专用 advanced 布局不能在 Linux 冒充验收。所有运行数据使用隔离目录，生产未切换或重启。

分支复查保留远端切换叠影修复：旧页优先读取 body/html 的不透明底色，新页拒绝 alpha 小于 1 的意图颜色；测试覆盖 rgba 和十六进制透明度。位置控件、图事件和模式 Provider 仍采用本轮公开接缝实现。
