# MewClaw Desktop 当前交接

更新时间：2026-09-17
工作分支：`desktop-dev`
本地同步基线：已合入 `origin/desktop@a36a7e0`（累计含 R32 计费纪元、R33 桌面推理三形态选择器与共享模型目录、R34-R37 品牌改名、R48 ws-crashguard、R49 bash schema、R52 OCI 出站网络 + 侧栏 10GB、R53 ui-sidebar-files 去重、R54 侧栏媒体流式转发、R55 移动端顶栏对齐、工具 schema 门禁与 STREAM_CLOSED/审计瞬态重试硬化）。途中远端 desktop-dev 已先行合入 `91bd7e6`（`de12683`），本分支在其上再合 desktop（`f48f39c`、`3b527c7`、`868fffa`、本轮 `a36a7e0`、`7e98458`）。最新合并 `b7f289d` 并入 `origin/desktop@7e98458`（`dd9a170` 移动端右坞毛玻璃 + `7e98458` master 合入），干净无冲突、仅触 `packages/lark/mewclaw-brand` 移动端文件，按既定边界不移植桌面变体；已推送并核验远端 `desktop-dev=b7f289d`。注意：主线 `06dc1af` 首次挂接 `upstream/dsh-desktop` 于 `a1ddcda8`（比本分支 pin `5510cb1203` 老），合并时保持本分支较新 pin 不回退。按交接约定 `packages/auth/edge` 下 `desktop-inference.ts`/`desktop-inference.test.ts`/`auth-routes.ts`/`server.ts`/`config.ts` 冲突全部取主线版本——本轮为思考强度元数据新增了 `DesktopSharedModel` 接口字段（见下），属本分支对 edge 的**新增**改动而非冲突取线。候选 `mewclaw-brand` workspace 是桌面变体的**展开副本**（剥离移动代码、无 `mobile` 选项）：上游改动中仅全视口生效的 `DEDUPE_STYLE`（隐藏会话头部 "Open right sidebar"）已手工移植；`@media(max-width:768px)` 与 rail 脚本类改动按设计不进入桌面。

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
| `MewClaw-1.0.0-win-x64-Portable.exe` | 155447616 | `8d0969b7e90f4db874008070f3a76a20fce8ba6c054bc6f7d8186fa25e8ab3e1` |
| `MewClaw-1.0.0-win-x64-Setup.exe` | 155691552 | `4fdeb4f4932384ea1bcdf6d555cfb63e18207172881dde019b24beeba1e56b17` |
| `MewClaw-1.0.0-win-x64.zip` | 197338819 | `cddb81c279358865b62fe65078ab37edd22e752ff8877a3c1cbd45056b432e5f` |

产物未签名。`win-unpacked` 与上述安装包位于同一 Release 目录，必须一起保留用于目录模式验收。**自本轮起发行形态为 `asar:false`**（应用根是 `resources/app/` 目录而非 `app.asar` 归档），与上游 2.0.10 发行形态一致——体积变大属预期。

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

当前结果（2026-09-16 全量 re-vendor 后）：

- **上游同步**：`upstream/dsh-desktop` 子模块 pin 升至 `5510cb1203`（anywhere-labs master），候选 `dsh-plugin-desktop` 全量 re-vendor 至 **2.0.10**（含隔离 Host 进程、compatibility-chrome、远程控制 pill、会话迁移、`packaged-runtime-smoke`/`packaged-filesystem-smoke` 扩展）；嵌套 `deepseek-harness` 对齐上游 rc.2 pin。裁剪项：vendored `@agents-anywhere/dsh-bridge-next`（`aaEnabled` 默认关）、`dsh-community-market`（默认 `disabled`）、`fs-ext`/`@vscode/ripgrep` 的 afterPack 钩子（我们的 electron-builder.cjs 不走该钩子，ripgrep 经 `files`+`asarUnpack`→随 asar:false 直接落在 `resources/app/node_modules/`）。
- **发行形态 `asar:false`**：上游 rc.2 起官方发行禁用 ASAR，我们跟随——实测 Electron 43 的 asar fs 补丁丢弃 `stat(path,{bigint:true})` 的 bigint 选项，`dsh-fs-local` 的 `mode & 511n` 在 asar 内必崩（`verifyBundledSkills` 与生产 skill 加载同路径），且 `require.resolve` 在 asar 内返回虚拟路径使 `rg.exe` 无法 spawn。`electron-builder.cjs` 改 `asar:false`（fuses 维持原配），`verify-package.mjs` 由归档断言改为目录遍历断言（`APP_ENTRYPOINTS_OK` 替代 `ASAR_ENTRYPOINTS_OK`）。
- **vendored 补丁清单**（每次 re-vendor 需重放，共 4 处）：①`profile.ts` `MEWCLAW_DESKTOP_CLOUD` → `dsh-lark-desktop-cloud` webserver；②`packaged-runtime-smoke.ts` `applicationRoot` 锚点适配 npm 提升布局（上游假设嵌套 `node_modules`）；③同文件 `rgPath` 断言→物理资源断言；④`src/client/styles.ts` 追加侧栏 backdrop-filter 反制规则（见下）。
- `verify-workspace`：22 个测试文件、74 个测试通过，输出 `WORKSPACE_OFFLINE_VERIFIED`。
- `verify-package`：`APP_ENTRYPOINTS_OK`、`OFFICIAL_RUNTIME_UNCHANGED 731`、`NATIVE_SPAWN_OK CLOUD_PROVIDER_IMPORT_OK`、Runtime smoke、`ZIP_PAYLOAD_MATCHES_VERIFIED_APP`、`MEWCLAW_PACKAGE_OK`。
- Release UI 冒烟 + CDP 实测（复制用户 profile 起包，原目录未触碰）：本地/云端两模式 `data-mew-glass="on"`、BootGraph 含 `dsh-lark-liquid-glass`、设置对话框 `{x:240,w:800,vw:1280}` 居中（修复前云端被压进 279px 侧栏）、本地 picker 分组与云端 `/auth/models` 一致（`DeepSeek` 5 项 + `openai` 4 项，云端命名）、cloud↔local 往返无重启无白屏。
- 已知噪声：切到本地后云端远端包里的 `dsh-better-sidebar` 客户端仍对本地端口重连 WS（`agent-terminals`/`agent-opens` 404），报"connection failed; stopping reconnect loop"后自停——无缝切换不换页的设计残留，无功能影响。
- 依赖例外：`liquid-glass-react@1.1.1` peer 声明 `react>=19`，桌面栈锁 React 18.3.1——该依赖只在 `client.ts`（React 组件面）使用，桌面侧仅注入无依赖的宿主面（config bootstrap + surfaces/wallpaper 样式），候选 vendored 包已从依赖表裁剪；主仓 pnpm 宽松 peer 不受影响。
- **云端推理错误分类**（2026-09-16 晚间修复）：`cloud-model.ts` 原先把一切上游失败收敛成 `CLOUD_INFERENCE_UNAVAILABLE`（R50/R52/R53 部署窗口用户报障即由此掩盖真实原因——当时 Auth Edge 重启约 20s 断档）。新增 `cloudFailure()` 分类：Edge 语义码从 pi-ai 文本两种形态提取（JSON `"error":"X"` 与裸 `403 "X"`），命中 `EDGE_ERROR_MESSAGES`（`PROMPT_AUDIT_REJECTED`/`MODEL_UNAVAILABLE`/`CLOUD_DEFAULT_MODEL_REQUIRED`/`CLOUD_INFERENCE_FAILED`/`INVALID_INFERENCE_REQUEST`）；无语义码按 HTTP 状态兜底（401/403/`AUTH`→`CLOUD_LOGIN_REQUIRED`、404→`MODEL_UNAVAILABLE`、409→`CLOUD_DEFAULT_MODEL_REQUIRED`、429→`RATE_LIMIT`、5xx→`CLOUD_INFERENCE_FAILED`）；`Stream ended without finish_reason` 归一为 `STREAM_CLOSED`、`TRANSPORT` 保码、abort 原样透出不映射；`CLOUD_INFERENCE_UNAVAILABLE` 仅留未知兜底。用户面消息全部替换为安全中文文案，不透出上游 body。
- **桥接重试策略**（2026-09-17）：`CloudAccountModel.providerRetryPolicy` 覆写为 `CLOUD_RETRY_POLICY`——官方默认集合 `[EMPTY_RESPONSE,RATE_LIMIT,SERVER,TIMEOUT,TRANSPORT]` 补 `STREAM_CLOSED` 与 `CLOUD_INFERENCE_FAILED`（与 `infra/linux/config/settings.production.yaml` 的 worker 集合同源），maxRetries 5、退避 500ms→10s。效果：部署重启窗口的连接 reset/断流/5xx 在步骤边界自动重试，不再直接打到用户面。注意此前 adapter 未覆写该方法——返回 `undefined` 时注册层解析为官方默认（TRANSPORT 已可重试），但 STREAM_CLOSED 与 Edge 5xx 语义码不在默认集合内。
- **本地模式思考强度滑条**（2026-09-17）：两端各一半。**服务端**：`DesktopSharedRuntime.listModels()` 条目新增可选 `reasoningEfforts`/`defaultReasoningEffort`（`desktop-inference.ts` 的 `DesktopSharedModel`）；`apps/auth/src/shared-model-runtime.ts` 对每条目录调用 `ctx.llm.resolveModelInfo` 取适配器权威元数据（resolve 失败只丢强度字段不丢条目），`/auth/models` 经 `sendJson` 直通。**桌面侧**：`cloud-model.ts` 解析该字段 → `sharedEntries`/`resolveModel` 透出 `reasoning`（picker 的 `modelCatalog` RPC 据此渲染强度控件）；`gatewayProfile` 的 pi-ai Model 置 `reasoning:true` + `thinkingLevelMap` 恒等映射使 `reasoning_effort` 上线（Edge 白名单原样吃强度词）。**`off` 档特殊处理**：pi-ai 在 options 层把 `off` 剥成"不携带"，只能靠 `thinkingLevelMap.off` 的回落分支发出——因此仅当服务端下发 `defaultReasoningEffort`（会话请求必带强度）时才展示 off 档，无默认值的模型摘掉 off 避免"未选强度被静默改写成关闭思考"。**UI 形态澄清**：官方上游选择器不是滑条——元数据到位后模型菜单出现「强度 ›」行（显示当前档位），点开是档位列表（含「Provider 默认」项）；与云端 mwseat 滑条形态不同属预期。**部署状态（2026-09-17 晚）**：生产仍 `R56-mobile-dock-blur-20260917`，其 `shared-model-runtime` 无 `reasoningEfforts`（grep 0 命中）——`/auth/models` 暂不下发该字段，强度项不会出现；`web-private` 私有模型无此元数据（服务端无法探知用户自建端点的强度集），云端模式同限。
- **本地模式登录态 reconcile**（2026-09-17）：未登录进入 local 时 `agentDefaultModel` 只能写占位 `mewclaw-cloud/cloud-default`；登录后此前不会重排，会话永久停在占位模型。现在 `wrap()` 在快照 cookie 处做迁移检测——`hasSession()`（`dsh_session`/`__Host-dsh_session` + `dsh_csrf` 双条件）由假转真且当前在 local 时触发 `localModelResync`：重新拉 `/auth/models` 并把默认模型校正为云端账号实际模型，不阻塞 location 控制面。`local-provider.test.ts` 起 loopback mock `/auth/models` 覆盖全链（占位→注入 cookie→目录拉取→默认模型变 `deepseek-official/smoke-v1`→路由含 `web-private`/`deepseek-official`/`mewclaw-cloud`）。
- **`cloudModelOrigin` 独立配置**（2026-09-17）：模型桥接（目录 + 推理）与页面代理 origin 解耦——`cloudOrigin` 仍管云端页面/工作区代理，`cloudModelOrigin`（Config 字段，空串回落 cloudOrigin，同一 `cloudOrigin()` 校验：外部必须 HTTPS、loopback 可 HTTP）管 `CloudAccountModel`。逃生口 `MEWCLAW_CLOUD_MODEL_ORIGIN` 环境变量优先于配置，供冒烟以 loopback mock 顶替目录，页面侧 `/auth/*` 仍走真实云端（`--switch` 云端访问不受影响）。
- **网关模型 `store:false` 越白名单**（2026-09-17 修复）：生产报 `INVALID_INFERENCE_REQUEST`——Edge `parseDesktopInference` 对请求体做逐字段白名单校验（`REQUEST_FIELDS`），而 pi-ai 对未知 provider 的 compat 探测给出 `supportsStore:true` → 每个请求都多带 `store:false` → 400。此前能通是因为生产 Edge 还是旧版（14:09 部署后才生效严格校验）。修复：`gatewayProfile` 的 pi-ai Model 置 `compat:{supportsStore:false}`；`cloud-model.test.ts` 的强度上线用例升级为全字段白名单断言（REQUEST_FIELDS 集合在测试内复制，任一新字段即红）。
- **冒烟脚本强化**（`apps/desktop/local-ui-smoke.mjs`）：`--directory` 用例自带 loopback mock `/auth/models`（下发 `deepseek-official/deepseek-smoke-v1`），注入假 `dsh_session`/`dsh_csrf` 后用以认证同站 `GET /` 触发 cookie 快照（`/api/mewclaw-desktop/*`、`/_dsh/*` 在快照前分流、`/auth/*` 依赖真实上游均不可用——`authorizeIndex` 带 token 会在快照前 303 返回，故用无参 `/`）；轮询至 mock 命中且模型文案出现，再点开本地目录并断言 composer 可编辑。渲染器错误门禁收窄：`/auth/*` 资源加载错误（假会话下真实上游行为）与 file:// 向导页 meta-CSP 提示剔除，其余异常仍即失败。实测全链：`DIRECTORY_COMPOSER_EDITABLE` → `RENDERER_ERRORS 0` → 双向 `LOCATION_SWITCH_OK`。

## 行为与兼容性修复

- 云端/本地切换改为进程内 location 状态变更和 renderer reload，不调用 Electron relaunch、quit 或 DesktopRuntime restart；两种会话历史分开保留。
- 切换的 renderer 刷新由裸 `location.reload()` 改为过渡面遮蔽的无缝重载：点击后旧页盖同色覆盖层再 reload，新文档在 BootGraph 前置脚本里重建过渡面，`#root` 有内容后淡出——无白屏闪烁、进程与窗口不变。实现见 `switch-splash.ts` / `session-boot.ts` / `location-client.ts`。
- 云端/本地同步边界按作用域划分：账号作用域（`/auth/models*`、`dsh-web-ui-settings`）本地模式转发云端；Harness 作用域（`/api/settings`、`/api/llm`、`/api/credentials` 等 `/api/*`）留在本机——云端的同名面指向共享部署管理配置而非账号配置，且官方在云端把 `dsh-client-ui-settings` 从 BootGraph 剔除（云端模式无此设置面板）。曾短暂把 Harness 作用域端点代理到云端，已回滚。
- 本地会话经云端代理推理。桌面只发送 `model` 选择器和当前账号 Cookie/CSRF；Auth Edge 依据 userId 在服务端解析路由与密钥并代理 SSE，API Key 不下发、不落盘、不进入日志。R33 起 `model` 字段是服务端路由选择器，三种形态：`cloud-default`（账号默认 profile 默认模型）、`account/<profileId>[/<model>]`（本人 profile 内任意已声明 modelId，裸 id 回落 defaultModel）、`shared/<provider>/<model>`（部署共享目录，Edge 进程内独立 Cordis 上下文承载 LlmRuntime，服务端凭证）。
- `/auth/models` GET 响应附带 `sharedModels`（`{provider, model, name}` 数组，无凭证字段）；未配置账号默认模型时 `cloud-default` 仍返回 `CLOUD_DEFAULT_MODEL_REQUIRED`，未知 profile/模型/共享项返回 `404 MODEL_UNAVAILABLE`。
- 本地模式只授予用户原生选择的目录文件能力；旧云端 workspace、Shell、同步桥接由独立 Web overlay 控制，不因切换本地模式静默启用。
- 切换到云端时释放本机目录 grant；切回本地只允许重新通过原生目录选择授权，Electron 进程仍保持运行。授权失效或会话未绑定目录时 `desktop_workspace` 抛 `LOCAL_WORKSPACE_NOT_AUTHORIZED` 并附重新授权指引（区分两种形态，指出失效的规范化路径，提示经侧栏「打开本地目录」重新选择）；同一目录重选即恢复，`workspaceRegistry.create` 按规范化路径去重不产生重复工作区。
- `electron-builder`、验包和 UI 冒烟按 `MewClaw-${version}-win-${arch}` 计算 Release 目录，避免版本并存和 `desktop.6` 歧义。
- **云端设置面板被困侧栏——已修复（2026-09-16）**：根因是 liquid-glass 主题包把 `backdrop-filter:blur(24px)` 应用在 `aside`/`nav` 结构容器上，`backdrop-filter` 会为 `position:fixed` 后代建立 containing block，设置对话框被钳进 279px 侧栏。双管齐下：①`packages/ui/liquid-glass/src/surfaces.ts` 拆分选择器——`panels`（结构+浮层）只上 fill/shadow，`floaters`（dialog/menu/listbox/alertdialog 等浮层）才上 backdrop-filter；`wallpaper.test.ts` 加回归断言（含 `backdrop-filter:blur` 的规则选择器不得覆盖 aside/nav）。②候选 `dsh-plugin-desktop/src/client/styles.ts`（vendored 补丁④）追加反制规则强制 `.dshDesktopSidebarSurface{backdrop-filter:none}`——云端页面的 glass 样式来自远端部署的旧 bundle，本地包修复鞭长莫及，反制规则由注入的桌面客户端承载，对老远端包立即生效；主题包重新部署后该规则无害保留。
- **本地模式模型列表与云端对齐——已修复（2026-09-16）**：根因是 web bundle 自带的 `llm-deepseek`（`dsh-llm-deepseek`）无条件注册 `deepseek-official` 并直连 `api.deepseek.com`，先占 id 导致云端桥接 `replace` 被跳过——本地 picker 显示原生目录（`DeepSeek-V41-Flash` 等）且推理不经云端。修复：候选 `dsh-plugin-desktop/cordis.patch.yml` 对 `llm-deepseek` 行 `disabled: true`（desktop patch 层在 `dsh-web-app` bundle patch 之后应用，行 id 可命中），`deepseek-official` 归云端桥；`cloud-model.ts` 的 `SHARED_PROVIDER_NAMES` 只对 `deepseek-official`→`DeepSeek` 做显示名映射，`openai` 等其余 provider 保持 id 原样与云端组名一致。CDP 实测本地 picker：DeepSeek 组=Muse Spark 1.3/DeepSeek V4.1 Flash/Qwen3.8 Flash/Ling 3.0 Flash/GLM 5.3 Flash，openai 组=GPT-5.6 Luna/Sol/Terra/GPT-6 Astra，与云端 `/auth/models` 目录逐项一致。
- **本地模式继承云端主题（液态玻璃）——已修复（2026-09-16）**：新增 `apps/desktop/plugins/cloud/src/local-glass.ts`（镜像 `local-brand.ts` 模式）：本地模式从候选 `liquid-glass` workspace 服务 `client.js` 与 JSON config bootstrap，`session-boot.ts` 在 location=local 时向 BootGraph 注入 `dsh-lark-liquid-glass` 条目（`inject:["theme","slots"]` 与 manifest 一致）；候选新增 `liquid-glass` workspace（vendored `packages/ui/liquid-glass`，裁剪 `liquid-glass-react` 依赖与 `client.ts` React 面——桌面只注宿主面）。实测两模式 `data-mew-glass="on"`、设置面板出现「液态玻璃」页、glass config/style 元素均在。
- ASAR 场景的 DSH profile fallback 生成物理代理目录，避免 Windows Junction 无法读取 `app.asar` 内 `package.json` 导致标准 preset 失效（本轮起 `asar:false`，该 fallback 逻辑保留以兼容旧 profile）。

## Web 端必须保持的配套

1. `apps/web` 或 `packages/client` 变更后，先构建并核对 `@deepseek-ai/dsh-web-frontend` 的 `dist/index.html`，再生成桌面候选和冻结锁；桌面 loopback WebServer 依赖该 dist。
2. 保持 `POST /auth/desktop-inference/chat/completions` 的 Cookie/CSRF、三形态 `model` 选择器、PromptAuditor、限流、SSE 超时（`desktopInferenceTimeoutMs`，默认 120s）和断开取消契约；桌面不接收 API Key。错误码：`CLOUD_DEFAULT_MODEL_REQUIRED`（409，默认 profile 缺失）、`MODEL_UNAVAILABLE`（404，profile/模型/共享项不存在或未装配）、`PROMPT_AUDIT_REJECTED`（403）、`CLOUD_INFERENCE_FAILED`（502，上游错误不透传）。
3. `/auth/models`、Web UI settings 只返回无凭证元数据（含 `sharedModels` 目录）；模型配置和密钥的唯一权威在云端账号服务。
4. 继续保留 Web 与桌面相同的 main/rightbar、品牌 slots 和静态资源路径；`/admin/` 管理台仍是独立 Web surface，嵌入桌面时另行处理路径前缀与 API origin。
5. `agent-presets` 不可用时返回空 roster 或结构化 `gateway/invocation-unavailable`，避免桌面首页裸 404；不要以 community-market 404 判断桌面启动失败。

## 待办与已知问题（交接）

### 1. 本地模式模型选项——已完成（服务端 R33 + 桌面端 picker 均已接入）

**状态更新（2026-09-15，接入完成）**：主线 `master@38795d2` 把 Edge `desktop-inference` 扩展为三形态选择器、`/auth/models` 附 `sharedModels` 目录（生产 `R33-desktop-inference-20260915` 已上线）。桌面端 picker 接入已完成并与云端 Worker 布局同构：`apps/desktop/plugins/cloud/src/cloud-model.ts` 初始注册 `mewclaw-cloud` 兼容桥（不列 picker 条目，仅保证旧的 `mewclaw-cloud/*` 已存选择可解析），拉取 `/auth/models` 后经 `AdapterRegistrationHandle.replace` 原子替换路由——`web-private`（"我的模型"，仅列默认 profile 的 `defaultModel`，与云端"只路由默认"语义一致）+ 按 `sharedModels[].provider` 动态注册的共享 provider（如 `deepseek-official`，列原始 model id + 服务端 `name`）；已被本机其他适配器占用的 provider id 跳过。本地 `(provider, model)` 选择器在 `stream` 时翻译为服务端选择器：`web-private/<defaultModel>` → `cloud-default`，共享 → `shared/<provider>/<model>`；`account/<pid>/<model>` 透传。未知选择器本地拒绝（`MODEL_NOT_FOUND`），不发推理请求；密钥仍全部在服务端。目录缓存 TTL 5s，`/auth/models` 非 GET 变更即失效。会话持久化的 provider/model 标识与云端模式一致，两种模式间切换不需要迁移已存选择。**修正（同日）**：`cloud-default` 占位条目曾无条件列在首位，无默认 profile 的账号会被默认选取命中报 `CLOUD_DEFAULT_MODEL_REQUIRED`——现改为仅在默认 profile 存在时列出；显式解析 `cloud-default`（旧会话残留选择）仍返回明确错误。测试 12 例覆盖三形态展开、动态 provider 路由、选择器透传、未知选择器拒绝、API Key 拒收。

**仍确认的事实**（picker 数据源结构不变）：本地 picker 的选项来自本机 `session/modelCatalog` = 已注册 llm 适配器；`mewclaw-cloud` 桥接适配器负责把账号侧目录投影为本地模型条目。

**sync 注意**（仍适用）：合入 `origin/desktop` 时 `packages/auth/edge` 下推理相关文件与 `auth-routes.ts` 路由块会与主线版本冲突，全部取主线版本；本分支不再维护这些文件。

### 2. 设置面板在两种模式不对称（已实质收敛，2026-09-16）

原注记已过时：实测云端模式现已有完整设置对话框（nav：账户中心/飞书连接/通用设置/模型/插件/Agent 预设/液态玻璃/侧边卡片/桌面设置），800px 居中——上一节"被困侧栏"修复后两种模式的设置面板几何一致。剩余差异仅为作用域语义：本地「模型」页显示本机 BYOK 提供方配置面（本地推理实际走云端桥，该面是死配置），如需隐藏是 UX 层的另行决策；账号级偏好走 `dsh-web-ui-settings`（已同步）、模型管理走 `/auth/models`（已同步）。

### 3. 上游 model-seat 包未过根 typecheck（官方包类型声明分叉，非合并回归）

合并带入的 `packages/lark/model-seat` 在根 `pnpm typecheck`（`tsconfig.test.json`）下失败。核实后的归因：`subagentAddress` 存在于 `dsh-api-session-controller`（客户端）的 `ISessions`，但 `dsh-session`（服务端）把 `Context.sessions` 声明为 `SessionStore`——根全量编译时服务端声明胜出，`client.ts:42` 报缺成员；`client.test.ts` 的 `El`/`SeatReactApi` 桩与 React 18 严格类型不兼容。该包自身 tsconfig 单独编译通过。修复方向（主线做）：model-seat 侧把 `ctx.sessions` 按客户端契约收窄，或根 typecheck 排除该包测试——不属桌面端改动范围。

### 4. 生产部署 desktop-dev（进行中，SSH 受限）

**目标**：`desktop-dev@b7f289d` 发布为 `R57-desktop-dev-reasoning-20260917`，使 `/auth/models` 下发 `reasoningEfforts`/`defaultReasoningEffort`（picker 强度项出现的前提），并把 liquid-glass `backdrop-filter` 修复带进云端 bundle。

**已备妥**：`/opt/dsh/source` 检出 `origin/desktop-dev` → `node scripts/package-linux-release.mjs --release-id R57-... --output-dir /opt/dsh/incoming`（packager 自建 stage + `pnpm install --frozen-lockfile` + `pnpm build` + `build:admin-web` + `validate-linux-release`）→ 解 tar 至 `/opt/dsh/releases/R57-...`（tar 为相对路径条目，无顶层目录，不要 `--strip-components`）→ 断言 `.dsh-release-manifest.json` 与 `apps/auth/dist/shared-model-runtime.js` 含 `reasoningEfforts` → `ln -sfn` + `mv -T` 原子翻 `/opt/dsh/current` → 重启 `dsh-auth dsh-worker dsh-gateway dsh-admin dsh-preview dsh-browser`。部署脚本已备于本机 `C:\Users\ATWER\AppData\Local\Temp\deploy-r57.sh`。`upstream/dsh-desktop` pin 不进发布面（`BUILD_STAGE_DIRS` 不含 `upstream/`），submodule 失败不阻塞。

**阻塞**：VPS SSH 端口 TCP 可达但 `kex_exchange_identification` 持续 reset——本机高频 SSH 轮询疑似触发对端限速/fail2ban；已停全部重连循环，待窗口恢复后先跑只读 preflight 再执行脚本。期间 `chat.rwr.ink` 服务正常（R56 在线）。

## 推送状态与限制

- 本轮改动基于 `origin/desktop@7e98458`，叠加远端 desktop-dev 合并（`de12683`）、无缝切换、同步边界修正、本地模式 picker 云端同构布局接入、上游 2.0.10 re-vendor、asar:false 发行形态、设置面板脱困/本地模型对齐/本地液态玻璃继承、桥接重试策略/思考强度元数据/登录态 reconcile/`store:false` 白名单对齐、测试和文档更新。合并提交 `f48f39c`、`3b527c7`、`b7f289d`；远端 `desktop-dev` 已核验 `b7f289d`。
- **品牌改名已进候选**：候选 `mewclaw-brand` workspace 的包名/插件名/客户端模块 id 已从 `dsh-lark-atw-brand` 改为 `dsh-lark-mewclaw-brand-desktop`（桌面变体语义，候选只保留这一个品牌 workspace）；`verify-package.mjs` 的断言路径同步更新。
- HTTPS 443 不通时经 mewclaw-vps SSH SOCKS 代理完成推送/拉取（系统 `ssh.exe` 有 WSASendCB 问题，须用 `C:\Program Files\Git\usr\bin\ssh.exe` 起 `-D 127.0.0.1:11080` 隧道，`git -c http.proxy=socks5h://127.0.0.1:11080`）；注意 origin 的 fetch refspec 只覆盖 `desktop`，desktop-dev 需显式 `git fetch origin +refs/heads/desktop-dev:refs/remotes/origin/desktop-dev`。
- 后续若继续修改源码或交接文档，完成提交后重新执行：

  ```text
  git push origin HEAD:desktop-dev
  git ls-remote origin refs/heads/desktop-dev refs/heads/desktop
  ```

- Auth Edge 已部署（R33，生产 `chat.rwr.ink`）；上述产物哈希即为 picker 云端同构布局接入后的构建，真实账号的模型请求验收可直接用该包进行。

---

# 生产侧同期变更记录（来自 desktop 主线，2026-09-16 合入）

以下为 `origin/desktop@868fffa` 合入的生产/Web 侧变更原文，与桌面端无直接耦合，保留供追溯。

## 举一反三防回归：schema 门禁 + STREAM_CLOSED 重试 + 审计重试（2026-09-16）

针对上一轮两个生产 bug 做的**类级**防回归（不只修实例）：

**1. 工具 schema 类（bash `type:null` 400）三层防线**
- `packages/bundle/web/tool-schema.mjs`：新共享 helper `registerModelTool(ctx, def)`——注册前断言 `parameters` 是 object 根 JSON Schema（含 required⊆properties、可 JSON 序列化），不合法在**插件装载期**抛错（boot-check 烟测即拦），而不是请求时被 provider 400。`pipe-bash.mjs` 与 `liangshen/custom-bash.mjs` 均已迁移。
- `scripts/verify-tool-schemas.mjs`（接入 `verify.mjs` 链）：`.mjs` 插件禁止直接 `tools.register(`；`.ts` 禁止 `tools.register({...})` 内联字面量。
- `tests/agent-tool-schemas.test.ts`：自动 glob `packages/bundle/web/**/*.mjs` 全部插件，代理 ctx 实际 apply，校验每个注册 definition——未来新增 .mjs 插件自动覆盖。

**2. STREAM_CLOSED 类（上游断流透到用户）**
- 根因补强：`dsh-llm-retry` 已随 dsh-base 挂载，但官方默认 `retryableCodes` 不含 `STREAM_CLOSED`——`worker/cordis.patch.yml` 的 `lark-deepseek-routing` 与 `settings.production.yaml` 的 `llm-deepseek` + pi-ai `openai` profile 三处都补上，瞬断在步骤边界持久化重试，整轮不再即败。
- 注意：审计模型直连 `ctx.llm.stream()` **不吃** llm-retry（重试只在 agent loop 内生效）。

**3. 审计瞬态失败类（用户可见"审计不可用"）**
- `createPromptAuditor` 加有界重试：快失败（传输/5xx/STREAM_CLOSED/解析残渣）重试一次；`AUDIT_TIMEOUT`（预算已耗尽）与确定性 finish code（AUTH/INVALID_*/QUOTA_EXCEEDED/MODEL_DISABLED/NO_CODE）不重试；仍 fail-closed。
- SPEC `prompt-security-audit.md`、`deepseek-routing.md` 已同步；composition 测试钉住 retryPolicy 配置。

**仍遗留**：lark-ws 的 SDK 残留错误兜底是实例级修复；同类模式（SDK 自持重连循环 + teardown 后 error 事件）的通则已写进 AGENTS.md「已验证经验」。Worker/审计的上游凭证失效属密钥轮换窗口，无代码侧修法。

## 生产双 bug 修复交接（2026-09-16）

多用户报错的两个独立缺陷已修复上线，详细归档见 `docs/evidence/incident-ws-crash-and-bash-schema-20260916.md`（本地证据目录，不入 git）。

**Bug 1 — 网关 WS 崩溃（R48-ws-crashguard，`4b5cd26`）**：`@larksuiteoapi/node-sdk` 握手看门狗 `removeAllListeners()` 后 `terminate()`，pre-open ws 发出无监听 `'error'` → 未捕获异常杀进程（9/9 崩溃环 13 次、9/15 两次）。`dsh-lark-ws` 挂过滤式 `uncaughtException`：仅吞栈在 node-sdk 的该文案残留错误（SDK 重连循环继续），其余异常保持 `exit(1)`。判定函数 `isLarkWsHandshakeStrayError` 在 `packages/lark/lark-ws/src/client.ts`；SPEC `lark-ws.md` §6 已补失败模式行。

**Bug 2 — bash 工具 schema 400（R49-bash-schema，`94cc747`）**：`packages/bundle/web/agent-presets-oci/pipe-bash.mjs` 绕过 `defineTool` 裸 `ctx.tools.register`，`parameters` 传未编译字段表（根无 `type:"object"`），native 模式 53 工具全量上线路时被 provider 400 拒绝（PTC 只发 `run_code` 故长期未炸）。已补 object 根 JSON Schema + 注册形态断言。**教训：preset `.mjs` 直接注册工具时 `parameters` 必须是 object 根 JSON Schema，不是字段表**。

另：`SSE stream ended without [DONE]`（STREAM_CLOSED）为上游 relay 瞬断，非缺陷，重发即可。

---

以下内容为历史交接。

# Web 共享能力交接（2026-09-10）

主题 `packages/ui/liquid-glass` 已随 `R3-title-nav-20260911` 发布 Linux 生产：官方双色 token、设置个人开关、自有 SVG 背景和 HTML/ARIA 语义材质；标题和横向标签保持透明无框，官方和其他包未改。49项测试及候选 Chromium 通过，六个生产服务均运行于当前 release，真实登录交互仍需用户实测。后续向 desktop 合入时保留共享包唯一实现，先核对桌面固定版 DSH 的主题 API，再创建独立候选验证；不可直接复制 Web 的官方版本锁定或修改社区子模块。当前尚未合入桌面分支，具体边界见 `packages/ui/liquid-glass/README.md`。

桌面工作区已从 desktop-dev 候选按文件迁入 `packages/desktop`，增加本机 Shell 和目录双向同步；桌面 Host/原生授权/打包仍由 `desktop` 分支维护。不要把 desktop-dev 整分支反向合并 master。

共享实现：`packages/desktop/host`、`packages/desktop/workspace`；认证入口：`packages/auth/edge/src/desktop-workspace.ts`；启用示例：`config/desktop-workspace.patch.yml`。默认禁用新绑定但保留持久化模式 guard；源码推送不等于生产启用。契约见 `docs/specs/desktop-workspace.md`。

本机目录授权不包含 Shell 或同步授权；两者分别原生确认。同步保留冲突和恢复副本，不离线重放写入。Shell 复用官方 Provider，不宣称目录沙箱。后续本地电脑从 desktop 拉取后合并自己的 desktop-dev，重点保留共享包唯一实现、单会话轮询与独立授权。生产启用和 Windows 实机验收仍须分别执行。

以下内容为历史附件交接，不代表本次未完成项或生产操作授权。

# DSH Lark 附件格式处理修复转交

更新时间：2026-08-14

> 文档状态：这是附件内容驱动管线的历史转交记录。初始现场状态和"未完成改动"章节保留用于追溯；当前实现与验证状态以仓库代码、`docs/evidence/` 和最新收口命令为准。

## 目标

后续由 Pi 在 `D:\AI\dsh` 继续开发。用户要求附件处理不能依赖文件扩展名硬编码，图片以及 `docx`、`xlsx`、`csv`、`py`、`rs`、无扩展名文件和其他格式都应优先按真实内容识别。

目标不是声称可以语义解析世界上所有二进制格式，而是建立统一的内容驱动管线：

1. 格式识别不依赖文件名或扩展名。
2. 任意可安全解码的文本都可读取，包括未知扩展名和无扩展名源码。
3. PDF、DOCX、XLSX 等富格式按真实 MIME 分派到已有解析器。
4. 图片按真实内容解码，必要时转换为视觉模型稳定支持的格式。
5. 已识别但暂无解析器的二进制文件应明确报告类型和限制，不得误称"加密""损坏"或"不可读"。
6. CDG/Esafenet 文件必须先走现有 CdgBridge 检查和受控明文物化，再识别明文内容。

## 已确认根因

用户在飞书发送图片后，模型回复无法读取，并错误推测文件被加密。

真实链路如下：

1. `packages/lark/lark-ws/src/inbound-message.ts` 将独立图片命名为 `image`，富文本图片命名为 `post-image-<n>`，均无扩展名。
2. `packages/lark/gateway/src/attachments.ts` 当前把附件 MIME 固定为 `application/octet-stream`。
3. Worker 将附件物化为工作区 `uploads/<id>/image`。
4. `packages/lark/uploads/src/index.ts` 原实现仅在路径扩展名属于图片白名单，或声明 MIME 以 `image/` 开头时进入视觉分析。
5. 因路径无扩展名且 MIME 为 `application/octet-stream`，视觉路由直接跳过。
6. 主模型 `deepseek-v4-pro` 是文本输入模型，原生 `read_image` 因模型不支持图片输入而拒绝；正确架构应由 `dsh-lark-vision` 先把图片转为结构化文本。

真实失败样本：

对检测 MIME 为 `image/*` 的文件使用 Sharp 解码，并设置像素、输入字节和输出字节上限。建议将视觉请求输入统一为 PNG，或仅在视觉供应商不支持源格式时转 PNG。

真实样本已验证 Sharp 可自动识别和解码：

```text
format: webp
dimensions: 1920 x 1088
PNG output: 2940072 bytes
```

注意 PNG 可能比源图大很多，必须保留输出大小上限。像素上限可与 DSH attachment 默认策略的 40,000,000 像素对齐。

### 4. 普通附件的模型可见内容

当前非知识库摄入场景主要只注入 `<authorized_attachments>` 路径，模型仍需自行调用工具。应评估在 `dsh-lark-uploads.prepare()` 中复用一次检测/提取结果：

- 图片注入 `<visual_analysis>`。
- 可提取文本或富格式注入有边界、可截断、带来源的附件内容块。
- 明确摄入知识库时复用同一提取结果，避免二次解析。
- 未知二进制注入明确类型和"暂无解析器"说明，防止模型自行猜测。

所有模型可见块必须先写入 `lark/run/context`，保持"模型可见等于已落盘"。

### 5. 保持的安全边界

- 不读取、打印、复制或修改 `.env`。
- 不绕过 CdgBridge inspect/decrypt。
- 不削弱 Scope 归属、路径包含、SHA-256 和大小复核。
- 不在 Gateway 执行工作区工具。
- 不把文件名、扩展名或上游 MIME 当作可信内容证明。
- 不自动发送真实飞书或模型 smoke 消息；真实消息由用户手动发送。
- 不回退或覆盖其他未提交修改。
- 不创建 `.codex-tasks`、TODO、验收或过程记录文件；本 `HANDOFF.md` 是用户明确要求的唯一转交文件。

## 已执行验证

初版有限修复曾执行以下验证并通过：

```powershell
pnpm exec vitest run packages/lark/uploads/src/index.test.ts packages/lark/uploads/src/extract-rich.test.ts
# 2 files passed, 7 tests passed

pnpm exec tsc -p packages/lark/uploads/tsconfig.json --noEmit
# exit 0

pnpm exec eslint packages/lark/uploads/src/extract.ts packages/lark/uploads/src/index.ts packages/lark/uploads/src/index.test.ts
# exit 0
```

真实样本通过当前临时代码识别为：

```json
{"mimeType":"image/webp","extension":".webp"}
```

这些结果只证明初版 WebP 修复；这是初始转交时的结论。当前分支已包含 `file-type`/`sharp` 驱动的统一检测与图片解码实现，是否部署到生产仍需按当前环境单独复核。

## 收口验证门禁

至少覆盖以下回归：

1. 无扩展名 WebP 被识别并进入视觉分析。
2. PNG/JPEG/GIF/AVIF/TIFF 等以实际 Sharp 支持能力为准，不需新增业务魔数。
3. 无扩展名或错误扩展名的 UTF-8、UTF-16、GB18030 文本可读取。
4. `.csv`、`.py`、`.rs` 不依赖白名单即可提取。
5. DOCX/XLSX/PDF 在扩展名缺失或错误时仍按真实内容分派。
6. 扩展名伪装的二进制不会被当成文本。
7. 未支持二进制给出确定类型和明确限制，不出现"可能加密"的猜测。
8. CDG 文件先解密，再按明文真实内容识别。
9. 图片解码炸弹、超大输入和超大转码输出被有界拒绝。
10. `lark/run/context` 仍先于模型提示词落盘。

建议定向命令：

```powershell
pnpm exec vitest run packages/lark/uploads/src/extract.test.ts packages/lark/uploads/src/extract-rich.test.ts packages/lark/uploads/src/index.test.ts packages/lark/uploads/src/materialize.test.ts
pnpm exec tsc -p packages/lark/uploads/tsconfig.json --noEmit
pnpm exec eslint packages/lark/uploads/src
pnpm exec tsc -b packages/lark/uploads apps/lark-worker
```

如需把当前实现部署到运行态，完成构建产物更新后再执行：

```powershell
pnpm service:restart
pnpm service:status
```

状态应显示 PostgreSQL 运行、Worker/Admin healthy、Gateway callback connected、profile 仍符合用户选择。最后由用户在飞书发送真实图片和多类文件进行验收。
