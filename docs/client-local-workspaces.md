# Desktop / TUI 本机工作区（2026-09-23）

本机模式让 Agent、工作区工具与会话日志在用户电脑运行；云端账号提供认证、模型目录和推理。云端会话独立保留，本地目录不发送给云端 workspace/create。供应商 API Key 不复制到电脑，模型请求仍会包含正常提交的提示词和工具结果。

## Windows Desktop

使用 desktop 分支构建的候选，登录账号后在侧栏选择“本地”，再从原有“选择工作区 / 添加工作区”浏览并打开目录。没有独立的“打开本地目录”按钮。切换保留各自工作区和历史，模型、账号中心、模式、思考强度滑条及其他 UI 复用 Web 同源组件。

官方 DSH 0.1.6-alpha.2、Cordis 4.0.2、Electron 44.0.0。宿主 FileSystem、Shell、Skills、计划和子代理依照官方 preset 与审批执行；工作区目录不是操作系统沙箱。Desktop 准备和验包步骤见 [桌面分支开发说明](https://github.com/AiharaMahiru/MewClaw/blob/desktop/apps/desktop/README.md)。

## TUI

本仓库的 packages/lark/tui-remote 是 Web 共享客户端；真正的 TUI 模型适配与界面源码在 [AiharaMahiru/dsh-TUI](https://github.com/AiharaMahiru/dsh-TUI)。请使用该 fork 的本机工作区实现，上游同版本 npm 包不包含这些改动。

```text
dsh-tui "D:\项目\我的工程"
/connect https://chat.rwr.ink
/model
```

登录后回到主界面，在模型选择器选择“MewClaw 云端账号”，正常聊天即可使用本机工具。也可通过 `/workspace open <目录>` 打开本机工作区。已验证 TUI 0.10.2、DSH 0.1.5-rc.1、Cordis 4.0.2；构建依赖与使用限制见 [TUI 本地账号文档](https://github.com/AiharaMahiru/dsh-TUI/blob/main/docs/local-account-workspace.md)。

旧 `/desktop-workspace` 桥接是云端会话借用本机工具的独立能力，不是本地会话的前置条件。

## 验证与交付边界

- Desktop 已验证 40 项 Web/本地 UI 清单及四种模式菜单一致，四种模式实际挂载、中文目录、新建会话、滑条、主题、键盘及双向切换通过。
- Windows EXE 在 Wine 下通过 advanced 界面、原生依赖和无头 CLI；847 个官方 JavaScript 文件未修改。Windows 本机文件回放及 21 条事件恢复通过。
- Desktop 和 TUI 分别通过真实云端账号模型的本机文件读写，以及无密钥回放；TUI 真实 PTY 模型选择、聊天显示和退出恢复已验证。界面测试与真实推理测试分别进行，不声称完整桌面 UI 到真实模型的端到端验收。
- Windows 实机安装、UNC/网络盘、ConPTY、原生窗口材质与 extended 布局仍待验收。候选未签名，尚未发布到 npm 或正式客户端渠道。

构建候选、账号文件、运行数据和完整截图日志不进入源码仓库；本页保留可追踪的实施及验证摘要。生产切换与客户端正式发布需单独执行。
