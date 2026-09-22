# 客户端本机工作区与账号模型

Desktop 与 TUI 的本机 Harness 通过 Auth Edge 推理端点使用云端模型，普通本机会话不需要旧 desktop-workspace 桥接。TUI 必须在交互 Host 用 Cordis effect 注册账号 LlmAdapter，复用官方 PiAiAdapter；工具和事件仍由本机 Agent 拥有。Desktop 注册共享 provider 时遇到本机同名路由，目录和默认选择都必须回退到 mewclaw-cloud 选择器。

固定 DSH 0.1.5-rc.2 的 FileSystem 要求 BigInt stat，Electron ASAR 虚拟目录不满足；本轮通过 asar:false 物理打包解决，不改官方包。自定义 Electron distribution 带来的 default_app.asar 示例也须从候选资源目录排除。社区运行时冒烟的路径预期须对应独立发行的 extraResources 与提升后依赖布局。

真实文件副作用、会话持久化/恢复与客户端普通聊天必须分别验证。Wine 下 Windows EXE 成功不等于 Windows 实机 UI/ConPTY 验收。使用与验证摘要见 docs/client-local-workspaces.md；原始证据保留于忽略 Git 的 docs/evidence/20260923-local-client-workspaces.md。
