# MewClaw Desktop 当前交接

更新时间：2026-09-12
工作分支：`desktop-dev`
本地同步基线：已拉取并合入最新 `origin/desktop@3d88e2d`，合并提交为 `ce3d0cc`；冲突已处理，保留桌面专属 Workspace、Shell、同步、Cloud Provider、admin/Auth 和液态玻璃 Web 更新。

## 当前唯一交付目录

只保留一个候选目录：

```text
D:\AI\dsh\MewClaw-desktop-candidate
```

Release 目录由候选版本自动计算，不再使用 `desktop.6` 或带日期/r 次数的目录名：

```text
D:\AI\dsh\MewClaw-desktop-candidate\release\MewClaw-1.0.0-win-x64
```

已删除旧的无后缀候选及 `MewClaw-desktop-candidate-20260912[-r2|-r3|-r4]` 多版本目录。`C:\Users\ATWER\AppData\Roaming\MewClaw` 未触碰。

## 当前 Release 产物

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `MewClaw-1.0.0-win-x64-Portable.exe` | 142872199 | `d9b1db86207aac46fb7473b60e596e3c4b8427ec7e83f7c84e8a00558fc72612` |
| `MewClaw-1.0.0-win-x64-Setup.exe` | 143116135 | `c44ae2cda79b5600836b7ca79faca20537e3877c51a9bafacdce05fce0df6f15` |
| `MewClaw-1.0.0-win-x64.zip` | 187022948 | `74003c18bc80abe02b2b5e44d9496509c8ad96c155ef6468399a3911a0df410d` |

产物未签名。`win-unpacked` 与上述安装包位于同一 Release 目录，必须一起保留用于目录模式验收。

## 构建与验证证据

在唯一候选目录使用 Node 24：

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node D:\AI\dsh\MewClaw-desktop\apps\desktop\verify-workspace.mjs D:\AI\dsh\MewClaw-desktop-candidate
node node_modules\electron-builder\cli.js --config electron-builder.cjs --win --x64 --publish never
node D:\AI\dsh\MewClaw-desktop\apps\desktop\verify-package.mjs D:\AI\dsh\MewClaw-desktop-candidate
node D:\AI\dsh\MewClaw-desktop\apps\desktop\local-ui-smoke.mjs D:\AI\dsh\MewClaw-desktop-candidate advanced --directory --switch
```

当前结果：

- 候选 DSH 依赖、冻结 `package-lock.json` 和 overrides 统一为 `0.1.5-rc.2`；官方 DSH 包未修改。
- `verify-workspace`：21 个测试文件、58 个测试通过，输出 `WORKSPACE_OFFLINE_VERIFIED`。
- `verify-package`：`ASAR_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED 731`、`NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK`、4 个 Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP`、`MEWCLAW_PACKAGE_OK`。
- Release UI 冒烟：`DIRECTORY_COMPOSER_EDITABLE`、`RENDERER_ERRORS 0`、`LOCATION_SWITCH_OK local-to-cloud`、`LOCATION_SWITCH_OK cloud-to-local`、`LOCAL_UI_OK advanced Release`。
- 候选改名后曾发现 Windows workspace Junction 指向旧 r4 路径；已在最终目录重新运行 npm 安装重建 Junction，并重新通过上述门禁。

## 行为与兼容性修复

- 云端/本地切换改为进程内 location 状态变更和 renderer reload，不调用 Electron relaunch、quit 或 DesktopRuntime restart；两种会话历史分开保留。
- 本地会话使用云端账号默认模型。桌面只发送 `cloud-default` 和当前账号 Cookie/CSRF；Auth Edge 依据 userId 在服务端读取账号配置与加密 API Key 并代理 SSE，API Key 不下发、不落盘、不进入日志。
- `/auth/models` 与 Web UI settings 继续由云端代理提供无凭证模型元数据；未配置账号默认模型时返回 `CLOUD_DEFAULT_MODEL_REQUIRED`。
- 本地模式只授予用户原生选择的目录文件能力；旧云端 workspace、Shell、同步桥接由独立 Web overlay 控制，不因切换本地模式静默启用。
- 切换到云端时释放本机目录 grant；切回本地只允许重新通过原生目录选择授权，Electron 进程仍保持运行。
- `electron-builder`、验包和 UI 冒烟按 `MewClaw-${version}-win-${arch}` 计算 Release 目录，避免版本并存和 `desktop.6` 歧义。
- ASAR 场景的 DSH profile fallback 生成物理代理目录，避免 Windows Junction 无法读取 `app.asar` 内 `package.json` 导致标准 preset 失效。

## Web 端必须保持的配套

1. `apps/web` 或 `packages/client` 变更后，先构建并核对 `@deepseek-ai/dsh-web-frontend` 的 `dist/index.html`，再生成桌面候选和冻结锁；桌面 loopback WebServer 依赖该 dist。
2. 保持 `POST /auth/desktop-inference/chat/completions` 的 Cookie/CSRF、账号默认模型解析、PromptAuditor、限流、SSE 超时和断开取消契约；桌面不接收 API Key。
3. `/auth/models`、Web UI settings 只返回无凭证元数据；模型配置和密钥的唯一权威在云端账号服务。
4. 继续保留 Web 与桌面相同的 main/rightbar、品牌 slots 和静态资源路径；`/admin/` 管理台仍是独立 Web surface，嵌入桌面时另行处理路径前缀与 API origin。
5. `agent-presets` 不可用时返回空 roster 或结构化 `gateway/invocation-unavailable`，避免桌面首页裸 404；不要以 community-market 404 判断桌面启动失败。

## 推送状态与限制

- 本轮改动基于 `origin/desktop@3d88e2d`，合并提交为 `ce3d0cc`，随后纳入 rc.2 依赖、进程内切换、Release 命名、ASAR fallback、测试和文档更新。
- 桌面同步实现基线 `1133a68e0c1bf23e3ef720916d8099302ea1e9fd` 已推送并由 `git ls-remote` 核验；本交接更新随后随文档提交推送，最终远端值以同一命令的最新输出为准；`desktop` 远端仍为 `3d88e2dcaed107b490a7863faa51aff792973ac7`。
- 后续若继续修改源码或交接文档，完成提交后重新执行：

  ```text
  git push origin HEAD:desktop-dev
  git ls-remote origin refs/heads/desktop-dev refs/heads/desktop
  ```

- Auth Edge 尚未部署，未做真实模型请求或生产切换；这些不属于本地 Release 验收范围。


