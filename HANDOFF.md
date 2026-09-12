# MewClaw Desktop 当前交接

更新时间：2026-09-12
工作分支：`desktop-dev`
本轮同步：已从 `origin/desktop` 拉取到 `554d5c7`，合并 DSH `0.1.5-rc.2` 与液态玻璃 Web 更新；合并冲突已处理并保留桌面专属本地 Workspace、Shell、同步和 Cloud Provider。

## 当前交付

- 独立候选：`D:\AI\dsh\MewClaw-desktop-candidate-20260912-r3`。
- 候选 npm 锁继续使用 DSH `0.1.5-rc.1`，桌面 Host、Cloud、Brand peer 范围同时兼容 `0.1.5-rc.1` 与 `0.1.5-rc.2`；服务器 Web 依赖为 rc.2。
- Release 输出：`release\desktop.6`。
  - `MewClaw-1.0.0-win-x64-Portable.exe` — 142,829,677 bytes — `c2decf8f0d1eae7e8ac4e6630d8ed215c1fe4eb444d23f001d8961cb1c28201d`
  - `MewClaw-1.0.0-win-x64-Setup.exe` — 143,073,626 bytes — `3dbe1518d5fd0f16fb9519de8a479aa0ac2c4b544b4511100625f621d801ecd4`
  - `MewClaw-1.0.0-win-x64.zip` — 186,979,225 bytes — `eaed0981a4ae9b1fd6071d8d2922e166dac1e8b19409f4c07697a6a25eb819ca`
- 不删除 `C:\Users\ATWER\AppData\Roaming\MewClaw`，其中包含用户 Profile、会话、项目与配置。

## 已执行验证

仓库根目录：

```text
pnpm install --frozen-lockfile --ignore-scripts       PASS
pnpm typecheck                                        PASS
pnpm build                                            PASS
pnpm lint                                             PASS
pnpm vitest run packages/desktop/host/src/shell.test.ts packages/ui/liquid-glass/src apps/desktop/plugins/cloud/src/provider.test.ts   28/28 PASS
node apps/desktop/packaging.test.mjs                  2/2 PASS
```

候选目录：

```text
npm ci --ignore-scripts --no-audit --no-fund            PASS
npm run build                                          PASS
node apps/desktop/verify-workspace.mjs <candidate>     21 files / 51 tests PASS
node electron-builder ... --win --x64                  PASS
node apps/desktop/verify-package.mjs ...               MEWCLAW_PACKAGE_OK
node apps/desktop/local-ui-smoke.mjs ... advanced --switch  LOCAL_UI_OK; RENDERER_ERRORS 0; local-to-cloud/cloud-to-local PASS
```

验包关键标记：`ASAR_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED`、`NATIVE_SPAWN_OK`、四个 Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP`、`MEWCLAW_PACKAGE_OK`。

## 本轮兼容性修复

- `generate-mewclaw-icon.mjs` 从脚本自身定位候选根目录，修复独立候选执行时错误解析到 `D:\AI\mewclaw-brand` 的 Windows 构建失败。
- `prepare-desktop-candidate.mjs` 使用平台路径分隔符保护候选覆盖上游，修复 Windows 子目录目标保护失效。
- Cloud、Host、Brand peer 范围同时接受候选 rc.1 与服务器 rc.2；候选 Brand manifest 在生成时与冻结 npm lock 对齐。
- Windows Shell 回归覆盖 PowerShell 冷启动，并隔离测试 `DSH_HOME`；液态玻璃路径断言兼容 Windows 分隔符。

## Web 端配套要求

1. 修改 `apps/web`、`packages/client` 或 Vite 配置后，必须先生成对应 `@deepseek-ai/dsh-web-frontend` dist，再更新候选锁文件；桌面 loopback WebServer 依赖 `dist/index.html`。
2. 候选准备/验包应增加前端 dist 来源与版本一致性门禁，避免桌面继续打包旧 dist。
3. Auth Edge 保持登录 Cookie、CSRF、限流、PromptAuditor 和 SSE 超时契约，API Key 只留在服务端；模型能力查询只返回无凭证元数据。
4. 本地模式只操作用户授权的本机 Workspace；旧云端桥接接口应明确失败，不能静默执行本地操作。
5. `agent-presets` 缺失时返回空 roster 或结构化 `gateway/invocation-unavailable`，避免桌面首页裸 404。
6. `/admin/` 管理台保持独立 Web surface；如嵌入桌面，需单独处理路径前缀、资源和 API origin。

## 限制与推送状态

- 本轮完成源码同步、兼容性修复、Windows Release 构建和无凭证 UI 冒烟；不代表生产部署、真实模型请求或 Windows 实机全量验收。
- 推送目标为 `origin/desktop-dev`。本轮 HTTPS push（HTTP/1.1、HTTP/2）均因 GitHub 443 连接失败，远端分支 SHA 未核验；网络恢复后执行 `git push origin HEAD:desktop-dev`，再以 `git ls-remote origin refs/heads/desktop-dev` 的 SHA 为准。
- 保留旧候选与生产回滚点，不清理用户数据、凭证或未授权目录。

