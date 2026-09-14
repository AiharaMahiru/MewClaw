# MewClaw Desktop 当前交接

更新时间：2026-09-14
工作分支：`desktop-dev`
本地同步基线：已拉取并合入最新 `origin/desktop@4efc4c5`，合并提交为 `5bc346b`；冲突已处理（README 版本表述、Auth Edge `server.ts` 拆分后 `desktop-inference` 路由重贴到 `auth-routes.ts`），保留桌面专属 Workspace、Shell、同步、Cloud Provider、admin/Auth、液态玻璃 Web 与无缝切换更新。

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
| `MewClaw-1.0.0-win-x64-Portable.exe` | 142874144 | `241eeae5a5807eb6428a2d0141e7851b27058abc7ea7293c0802e6cd4f26b406` |
| `MewClaw-1.0.0-win-x64-Setup.exe` | 143118098 | `93b78a9968f641d9e1a103f628662064eb1c10c709cae12ed941252ef8e39c9b` |
| `MewClaw-1.0.0-win-x64.zip` | 187029794 | `f728c8450a06ff7075c33732d3b32f5b34fd0ef7802ef3f799bcf539a2ba3bed` |

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
- `verify-workspace`：22 个测试文件、62 个测试通过，输出 `WORKSPACE_OFFLINE_VERIFIED`。
- `verify-package`：`ASAR_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED 731`、`NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK`、4 个 Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP`、`MEWCLAW_PACKAGE_OK`。
- Release UI 冒烟：`DIRECTORY_COMPOSER_EDITABLE`、`RENDERER_ERRORS 0`、`LOCATION_SWITCH_OK local-to-cloud`、`LOCATION_SWITCH_OK cloud-to-local`、`LOCAL_UI_OK advanced Release`。
- 候选改名后曾发现 Windows workspace Junction 指向旧 r4 路径；已在最终目录重新运行 npm 安装重建 Junction，并重新通过上述门禁。

## 行为与兼容性修复

- 云端/本地切换改为进程内 location 状态变更和 renderer reload，不调用 Electron relaunch、quit 或 DesktopRuntime restart；两种会话历史分开保留。
- 切换的 renderer 刷新由裸 `location.reload()` 改为过渡面遮蔽的无缝重载：点击后旧页盖同色覆盖层再 reload，新文档在 BootGraph 前置脚本里重建过渡面，`#root` 有内容后淡出——无白屏闪烁、进程与窗口不变。实现见 `switch-splash.ts` / `session-boot.ts` / `location-client.ts`。
- 云端/本地同步边界按作用域划分：账号作用域（`/auth/models*`、`dsh-web-ui-settings`）本地模式转发云端；Harness 作用域（`/api/settings`、`/api/llm`、`/api/credentials` 等 `/api/*`）留在本机——云端的同名面指向共享部署管理配置而非账号配置，且官方在云端把 `dsh-client-ui-settings` 从 BootGraph 剔除（云端模式无此设置面板）。曾短暂把 Harness 作用域端点代理到云端，已回滚。
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

## 待办与已知问题（交接）

### 1. 本地模式模型选项与 `CLOUD_DEFAULT_MODEL_REQUIRED`（用户已报告，待决策）

**现象**：本地模式下模型选择器只显示"云端默认模型"一项（`mewclaw-cloud/cloud-default` 桥接占位符），与云端模式的全量模型列表不对称；账号无默认私有模型时报 `CLOUD_DEFAULT_MODEL_REQUIRED`。

**已确认的事实**：

- 本地 picker 的选项来自本机 `session/modelCatalog` = 已注册的 llm 适配器。本地 Harness 装了 `dsh-llm-deepseek`、`dsh-llm-pi-ai`（需在本机凭据里配 key 才出现）+ `mewclaw-cloud` 桥接适配器。
- 桥接适配器（`cloud-model.ts`）按 SPEC §6 设计只暴露一个 `cloud-default` 条目，对应账号 `/auth/models` 的默认 profile；`resolveModel` 拒绝其他 ID。
- `keyConfigured` 在 Edge 的 `publicUserModelProfile` 里恒为 `true`，所以该错误实际等价于**账号没有任何设为默认的私有模型 profile**。
- Edge `desktop-inference` 只走 `resolveMyDefaultModelRoute`（私有默认路由，baseUrl+apiKey 服务端解析），无共享池回退；Worker 会话路径才有 `mode:'shared'` 兜底。

**用户期望**（原话）："切换工作模式，只有会话列表、会话和工作区变化，其他模型设置、软件设置等其他配置都不变" → 本地模式的模型选项应与云端一致。

**两条路，需要用户/服务端决策**：

- A. 维持现状：用户在"模型管理"（/auth/models）配置一个带 API Key 的私有模型并设为默认即可用；只用自己的共享池模型的账号在本地模式无推理能力（SPEC 既定边界）。
- B. 服务端扩展：本地模式支持共享池/任意账号模型，需要改 Edge `desktop-inference`（接受模型参数 + 共享路由）和可能的 Worker 计费路径 + SPEC 更新——不是桌面端单独能完成的工作量。

### 2. 设置面板在两种模式不对称（结构性，已知悉）

云端模式官方把 `dsh-client-ui-settings` 从 BootGraph 剔除，设置对话框不存在（管理员除外）；本地模式有该面板，管理的是本机 Harness 配置（`/api/settings` 本机文档）。账号级偏好走 `dsh-web-ui-settings`（已同步）、模型管理走 `/auth/models`（已同步）。本地模式设置→模型页显示的本机提供方列表是死配置面（本地推理走云端桥接），如需隐藏是 UX 层的另行决策。

### 3. 上游 model-seat 包未过根 typecheck（上游问题，非合并回归）

合并 `origin/desktop@4efc4c5` 带入的 `packages/lark/model-seat` 在根 `pnpm typecheck`（`tsconfig.test.json`）下失败：`client.test.ts` 的自定义 `El`/`SeatReactApi` 桩与 React 18 类型不兼容、`client.ts:42` 调用 `ctx.sessions.subagentAddress`（rc.2 已安装包里无此成员）。上游分支自身同样失败；该包自身 `tsconfig.json`/`tsconfig.client.json` 单独编译通过。修复需上游补桩类型/确认 `subagentAddress` 来源版本，或由上游把测试排除出根 typecheck——不属桌面端改动范围。

## 推送状态与限制

- 本轮改动基于 `origin/desktop@4efc4c5`，合并提交为 `5bc346b`，叠加无缝切换、同步边界修正、测试和文档更新。
- 本轮实现与交接基线 `bd873dcd229b0da2eba373627ee05490081ec2be` 已推送并由 `git ls-remote` 核验（HTTPS 443 不通时经 mewclaw-vps SSH SOCKS 代理完成）；`desktop` 远端仍为 `3d88e2dcaed107b490a7863faa51aff792973ac7`。
- 后续若继续修改源码或交接文档，完成提交后重新执行：

  ```text
  git push origin HEAD:desktop-dev
  git ls-remote origin refs/heads/desktop-dev refs/heads/desktop
  ```

- Auth Edge 尚未部署，未做真实模型请求或生产切换；这些不属于本地 Release 验收范围。


