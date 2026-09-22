# MewClaw 桌面开发入口

本文件位于 `master`（Web、共享插件与云端服务分支）。最新 Windows 客户端的源码、依赖锁与构建步骤维护在 [`desktop`](https://github.com/AiharaMahiru/MewClaw/tree/desktop) 和 [`desktop-dev`](https://github.com/AiharaMahiru/MewClaw/tree/desktop-dev)，请按[桌面分支开发说明](https://github.com/AiharaMahiru/MewClaw/blob/desktop/apps/desktop/README.md)构建。本分支保留的桌面代码是历史基线。

2026-09-23 的 Desktop 实现支持云端／本地分段切换，本机目录从原有工作区选择器进入；UI、插件、四种模式及滑条复用 Web 组合。Desktop 候选依赖为 DSH `0.1.6-alpha.2`、Cordis `4.0.2`、Electron `44.0.0`。使用与验收边界见[本机工作区说明](../../docs/client-local-workspaces.md)。

共享修复先进入 `master`，再按 `master → desktop-dev/desktop` 普通合并，保留共同历史。桌面专属实现留在桌面分支；各端独立发布，Git 推送不代表生产切换或安装包发布。候选、运行数据与凭证不提交。
