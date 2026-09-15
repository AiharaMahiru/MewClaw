# MewClaw Desktop 当前交接

更新时间：2026-09-15
工作分支：`desktop-dev`
本地同步基线：已拉取并合入 `origin/desktop@c627dae`（merge master 带入 R32 计费纪元/管理端按用户用量 + R33 桌面推理三形态选择器与共享模型目录，均已部署生产），合并提交为 `889230f`。按交接约定 `packages/auth/edge` 下 `desktop-inference.ts`/`desktop-inference.test.ts`/`auth-routes.ts`/`server.ts`/`config.ts` 冲突全部取主线版本，本分支不再维护这些文件。

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
- 本地会话经云端代理推理。桌面只发送 `model` 选择器和当前账号 Cookie/CSRF；Auth Edge 依据 userId 在服务端解析路由与密钥并代理 SSE，API Key 不下发、不落盘、不进入日志。R33 起 `model` 字段是服务端路由选择器，三种形态：`cloud-default`（账号默认 profile 默认模型）、`account/<profileId>[/<model>]`（本人 profile 内任意已声明 modelId，裸 id 回落 defaultModel）、`shared/<provider>/<model>`（部署共享目录，Edge 进程内独立 Cordis 上下文承载 LlmRuntime，服务端凭证）。
- `/auth/models` GET 响应附带 `sharedModels`（`{provider, model, name}` 数组，无凭证字段）；未配置账号默认模型时 `cloud-default` 仍返回 `CLOUD_DEFAULT_MODEL_REQUIRED`，未知 profile/模型/共享项返回 `404 MODEL_UNAVAILABLE`。
- 本地模式只授予用户原生选择的目录文件能力；旧云端 workspace、Shell、同步桥接由独立 Web overlay 控制，不因切换本地模式静默启用。
- 切换到云端时释放本机目录 grant；切回本地只允许重新通过原生目录选择授权，Electron 进程仍保持运行。
- `electron-builder`、验包和 UI 冒烟按 `MewClaw-${version}-win-${arch}` 计算 Release 目录，避免版本并存和 `desktop.6` 歧义。
- ASAR 场景的 DSH profile fallback 生成物理代理目录，避免 Windows Junction 无法读取 `app.asar` 内 `package.json` 导致标准 preset 失效。

## Web 端必须保持的配套

1. `apps/web` 或 `packages/client` 变更后，先构建并核对 `@deepseek-ai/dsh-web-frontend` 的 `dist/index.html`，再生成桌面候选和冻结锁；桌面 loopback WebServer 依赖该 dist。
2. 保持 `POST /auth/desktop-inference/chat/completions` 的 Cookie/CSRF、三形态 `model` 选择器、PromptAuditor、限流、SSE 超时（`desktopInferenceTimeoutMs`，默认 120s）和断开取消契约；桌面不接收 API Key。错误码：`CLOUD_DEFAULT_MODEL_REQUIRED`（409，默认 profile 缺失）、`MODEL_UNAVAILABLE`（404，profile/模型/共享项不存在或未装配）、`PROMPT_AUDIT_REJECTED`（403）、`CLOUD_INFERENCE_FAILED`（502，上游错误不透传）。
3. `/auth/models`、Web UI settings 只返回无凭证元数据（含 `sharedModels` 目录）；模型配置和密钥的唯一权威在云端账号服务。
4. 继续保留 Web 与桌面相同的 main/rightbar、品牌 slots 和静态资源路径；`/admin/` 管理台仍是独立 Web surface，嵌入桌面时另行处理路径前缀与 API origin。
5. `agent-presets` 不可用时返回空 roster 或结构化 `gateway/invocation-unavailable`，避免桌面首页裸 404；不要以 community-market 404 判断桌面启动失败。

## 待办与已知问题（交接）

### 1. 本地模式模型选项——服务端已就绪（B 路已实现并上线 R33），桌面端待接入

**状态更新（2026-09-15）**：主线 `master@38795d2` 已把 Edge `desktop-inference` 移植回主线并扩展为三形态选择器，`/auth/models` 附带 `sharedModels` 目录，部署为 `R33-desktop-inference-20260915`（生产已上线，端点 CSRF→401 链路验证通过）。SPEC 见 `docs/specs/auth.md` §6 桌面推理段。**桌面端 picker 扩展是剩余工作**：

- `apps/desktop/plugins/cloud/src/cloud-model.ts`：`session/modelCatalog` 目前只注册 `cloud-default`。改为拉 `/auth/models` 后展开全部选项：
  - `profiles[].modelIds` 每项 → 选择器 `account/<profileId>/<model>`（显示名建议 `<profile.displayName> · <model>`）
  - `sharedModels[]` 每项 → 选择器 `shared/<provider>/<model>`（显示名建议 `<name>`）
  - 保留 `cloud-default` 作为"账号默认"条目（账号默认 profile 的默认模型）
- 桥接适配器 `resolveModel`/校验逻辑需放开 `account/`、`shared/` 前缀（当前只认 `cloud-default`）；推理请求直接把选择器透传为 `model` 字段，密钥仍全部由服务端持有
- `account/<pid>` 的 profile 缺失或 `model` 不在 `modelIds`、共享项下线 → `404 MODEL_UNAVAILABLE`；无默认 profile 时 `cloud-default` → `409 CLOUD_DEFAULT_MODEL_REQUIRED`（UI 可引导去模型管理）
- 无账号私有 profile 的用户现在可直接用 `shared/*` 推理（部署密钥在服务端），`CLOUD_DEFAULT_MODEL_REQUIRED` 不再是硬阻塞
- **sync 注意**：合入 `origin/desktop` 时 `packages/auth/edge` 下桌面端旧版推理文件与 `auth-routes.ts` 路由块会与主线版本冲突，全部取主线版本；本分支不再维护这两个文件

**仍确认的事实**（picker 数据源结构不变）：本地 picker 的选项来自本机 `session/modelCatalog` = 已注册 llm 适配器；`mewclaw-cloud` 桥接适配器负责把账号侧目录投影为本地模型条目。

### 2. 设置面板在两种模式不对称（结构性，已知悉）

云端模式官方把 `dsh-client-ui-settings` 从 BootGraph 剔除，设置对话框不存在（管理员除外）；本地模式有该面板，管理的是本机 Harness 配置（`/api/settings` 本机文档）。账号级偏好走 `dsh-web-ui-settings`（已同步）、模型管理走 `/auth/models`（已同步）。本地模式设置→模型页显示的本机提供方列表是死配置面（本地推理走云端桥接），如需隐藏是 UX 层的另行决策。

### 3. 上游 model-seat 包未过根 typecheck（官方包类型声明分叉，非合并回归）

合并带入的 `packages/lark/model-seat` 在根 `pnpm typecheck`（`tsconfig.test.json`）下失败。核实后的归因：`subagentAddress` 存在于 `dsh-api-session-controller`（客户端）的 `ISessions`，但 `dsh-session`（服务端）把 `Context.sessions` 声明为 `SessionStore`——根全量编译时服务端声明胜出，`client.ts:42` 报缺成员；`client.test.ts` 的 `El`/`SeatReactApi` 桩与 React 18 严格类型不兼容。该包自身 tsconfig 单独编译通过。修复方向（主线做）：model-seat 侧把 `ctx.sessions` 按客户端契约收窄，或根 typecheck 排除该包测试——不属桌面端改动范围。

## 推送状态与限制

- 本轮改动基于 `origin/desktop@c627dae`，合并提交为 `889230f`，叠加无缝切换、同步边界修正、测试和文档更新。
- `desktop` 远端现为 `c627dae`（含 R32/R33，均已部署生产；R33 提供三形态推理选择器与共享模型目录）。本分支推送后重新核验 `git ls-remote`（HTTPS 443 不通时经 mewclaw-vps SSH SOCKS 代理完成）。
- 后续若继续修改源码或交接文档，完成提交后重新执行：

  ```text
  git push origin HEAD:desktop-dev
  git ls-remote origin refs/heads/desktop-dev refs/heads/desktop
  ```

- Auth Edge 已部署（R33，生产 `chat.rwr.ink`）；桌面端真实模型请求与 picker 接入验收属于下一次候选构建范围。


