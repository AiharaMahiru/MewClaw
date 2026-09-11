# MewClaw Desktop 当前交接

更新时间：2026-09-11
工作分支：`desktop-dev`
上游基线：`origin/desktop`（已 fetch，当前分支已包含，无待合并提交）

## 当前交付边界

- Windows Release 版本为 `1.0.0`，候选树为 `D:\AI\dsh\MewClaw-desktop-candidate`。
- 产物目录为 `release\desktop.6`，只保留以下三个最新文件：
  - `MewClaw-1.0.0-win-x64-Portable.exe`
  - `MewClaw-1.0.0-win-x64-Setup.exe`
  - `MewClaw-1.0.0-win-x64.zip`
- Windows 图标来自品牌插件 `FAVICON_SVG`，构建脚本为 `apps/desktop/generate-mewclaw-icon.mjs`，输出 `mewclaw-brand/build/app-icon.ico`；Electron Builder 已使用该 ICO。
- 不删除 `C:\Users\ATWER\AppData\Roaming\MewClaw`。该目录包含用户 Profile、会话、项目和配置。

## 构建与验证

在候选树中执行：

```powershell
npm run build
node node_modules/electron-builder/cli.js --config electron-builder.cjs --win --x64 --publish never --config.directories.output=release/desktop.6
node D:\AI\dsh\MewClaw-desktop\apps\desktop\verify-package.mjs D:\AI\dsh\MewClaw-desktop-candidate --release-dir=release/desktop.6
```

验收必须包含 `ASAR_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED`、`NATIVE_SPAWN_OK`、四个 Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP` 和 `MEWCLAW_PACKAGE_OK`。Release 是交付物，不能用 debug 或缓存目录替代。

## Web 端必须保持的契约

1. 保留 `packages/auth/edge/src/desktop-inference.ts` 及其测试，并与 `server.ts`、`config.ts`、`server.test.ts` 一起部署。
2. 提供 `POST /auth/desktop-inference/chat/completions`：继续使用登录 Cookie、CSRF、用户限流和 PromptAuditor；SSE 代理必须关闭缓冲，并遵守 `AUTH_DESKTOP_INFERENCE_TIMEOUT_MS`（默认 120000 ms）。
3. 模型路由只使用认证账号的私有默认模型，API Key 留在服务器；未配置私有默认模型返回 409。不能把模型列表或固定别名当作真实推理能力证明。
4. 本地电脑模式只读写本机 Workspace，不依赖云端 `desktop-workspace` overlay；旧云端桥接接口应继续返回明确的 409，而不是静默执行本地操作。
5. 后续若增加模型能力查询，接口只返回不含凭证的上下文窗口、输出上限和多模态能力；共享模型回退必须另行接入服务端额度/计费规则并重新验收。
6. 可选的 `agent-presets` 未安装时，Web 端应把 `agentPresets/list` 的能力缺失转换为空 roster 或结构化 `gateway/invocation-unavailable`；不要让本地桌面首页产生裸 404 网络错误。

## 现场错误分类

如果启动窗口显示 `Invalid package ...\\resources\\app.asar`，错误来自 Electron ASAR 读取层，通常表示 Portable 在临时目录中的 `app.asar` 解包或读取失败，不等同于 Profile 数据损坏。先关闭同一 Portable 的残留进程，使用 `Setup.exe` 安装版复核；不要删除用户数据，也不要用兼容模式结果替代正常启动验收。若安装版仍复现，应保留完整临时路径、产物 SHA-256、Windows 版本和错误日志，再定位 ASAR/杀毒软件/文件锁问题。

## 推送前门禁

- 工作树不得包含未说明的构建临时文件、旧版本产物或用户数据变更。
- `HANDOFF.md` 只描述本交接版本，不保留已过期的 desktop.5 历史结论。
- 推送目标为 `origin/desktop-dev`；推送后用远端分支 SHA 和 Release 验证结果回报，不声称已部署生产。
