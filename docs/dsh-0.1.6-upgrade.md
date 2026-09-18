# DSH 0.1.6 升级评估与修复计划

> 状态：**已实施于 `upgrade/dsh-0.1.6-alpha.2`**。全部 `@deepseek-ai/dsh-*` 锁 `0.1.6-alpha.2`（npm `alpha` tag；`next` 仍停 rc.2）。评估命中点全部处理完毕，核验证据见 §五「实施记录」。

信息来源：官方 release notes（deepseek-ai/deepseek-harness releases）、npm dist-tag 实况、本仓库逐条 grep 实证。标注「实证」的条目均有本仓库文件命中；标注「待证」的是官方语义需在候选上验证的点。

## 一、版本面

| 项 | 当前 | 上游 |
| --- | --- | --- |
| `@deepseek-ai/dsh-*` | `0.1.5-rc.2`（`next` tag） | `0.1.6-alpha.2`（`alpha` tag，全家桶同步） |
| `dsh-better-sidebar`（无 scope 第三方包） | `0.18.0` | `0.19.1`（09-11 发布；peer `dsh-llm ^0.1.5-rc.1`） |
| `upstream/dsh-desktop` pin（desktop-dev） | `5510cb1203`（v2.0.10） | `a934d988`，ahead 10（beta 通道已切 0.1.6-alpha.2 内核） |

## 二、破坏性变更 → 本仓库命中点

### 2.1 执行边界接口（最高优先）

**`SandboxProvider.confine` 与 `ShellExecutor.start` 改为可取消异步接口，准备时间计入超时。**

- 实证命中：`packages/sandbox/oci/src/runtime.ts:279` `confine(argv, policy)` 为同步签名返回 `ConfinedArgv`；R57（`6046bb2`）新增的容器名冲突回收重试与 `bindingFor` 失败逐出逻辑都在这条路径上。
- 修复方向：签名改异步可取消（abort signal 透传到 podman provision）；R57 的回收/逐出语义原样保留到新签名下；e2e 用例补「取消中的 provision 不留孤儿容器」。

### 2.2 会话与事件 API

**弃用 Session 同步历史读取 `snapshotEvents`/`eventAt`/`ownEvents`。**

- 实证命中两处：`packages/desktop/workspace/src/journal.ts:15` `session(id).snapshotEvents()`（桌面工作区 journal）；`packages/lark/run/src/agent-bootstrap.ts:23-34` 有兼容垫片（`snapshotEvents` 缺失时回落 `events`/`header.agentPreset`）。
- 修复方向：journal.ts 改异步读取接口（0.1.6 应提供替代面，升级时按新 API 替换）；agent-bootstrap 垫片天然兼容可直接验证。

**`agent/session-start` 改为异步串行 `agent/created`，首次模型请求等待初始化完成。**

- 实证：本仓库无 `session-start`/`agent/created` 引用（grep 0 命中），无直接命中；仍需在候选上确认官方各 preset 内部迁移完整。

**客户端 Session 多实例共存，相关 API 及 slot 有变化。**

- 实证命中：`packages/auth/edge/src/rpc-policy.ts:19` 的 SESSION_METHODS 白名单枚举 `session.history`、`session.fork`、`session.attachment`、`agentPreset.select`、`workspace.archiveSession`、`subagent.*`/`subagents.*` 等四十余方法；`:387` 对 `subagent.`/`subagents.` 前缀做归属校验。
- 影响：白名单是 fail-closed——0.1.6 改/新增的方法名会被默认拒绝（安全方向正确，但功能静默失效）；slot 变化影响品牌插件锚点。
- 修复方向：升级时对照 0.1.6 客户端 RPC 目录重审白名单全表，新增方法逐个定授权级；`session.history` 若改异步语义需验证 UI 路径。

**新增 `image offload` 会话事件**（记录请求中省略的历史图片，恢复/分叉保留）。

- 正向：与本仓库「模型可见 ⟺ 已落盘」纪律同向。需在升级时确认事件 schema 并让会话日志消费方（审计/导出）知晓新类型。

### 2.3 工具与 preset 面

**PTC 包名/服务名统一 `ptc-runtime` 系、工作流执行器改 `workflow-ptc`（旧名不兼容）；Node PTC 独立进程执行且 `process.env` 为空；`run_code` 支持按次超时（默认 120s/上限 600s）。**

- 实证命中：`packages/bundle/web/agent-presets/liangshen/agent.cordis.yml` 引 `dsh-workflow-worker-thread`(:348)、`dsh-tool-workflow`(:353)、`dsh-tool-ralph`(:356)；`tool-bootstrap.mjs` 的 `promotedPresentation: ptc`(:80)；`packages/auth/auth/src/policy.ts:14` `FULL_PRESETS` 含 `ptc` preset id。
- npm 实况：`dsh-ptc` 不存在于 0.1.6，`dsh-ptc-runtime`/`dsh-workflow-ptc` 存在；`dsh-workflow`/`dsh-tool-subagent`/`dsh-tool-ralph`/`dsh-tool-cordis` 在 0.1.6 均有同名版本（改名面集中在 PTC 引擎包与 workflow 执行器）。
- 修复方向：liangshen composition 中 PTC/workflow 相关行按新包名重挂；`ptc` preset id 若随官方改名需同步 `policy.ts`；`process.env` 为空对 `run_code` 用户代码是行为变化，preset 注释需更新。

**Team 模式统一 `spawn_teammate`，关闭 `subagent`/`subagent_fork`，队友上限 8→16。**

- 实证命中：liangshen preset `tool-subagent`(provider spawn, toolName `subagent`)、`tool-subagent-fork`(provider fork, toolName `subagent_fork`)，`backgroundMode: continuable`（agent.cordis.yml:312-323）。
- 影响范围限定「实验性 Team 模式」；普通会话的 spawn/fork 工具面待证是否保留。升级时验证 liangshen 与 standard 系 preset 的委派工具在新语义下的呈现。

**Ralph 默认不再启用。**

- liangshen preset 显式挂载 `dsh-tool-ralph`(:356)——显式挂载路径待证是否受「默认不启用」影响；standard 系若依赖默认开启需补显式挂载。

**创造模式移除 Cordis 动态定义/运行工具，改走 Plugin Manager 安装持久化插件。**

- 实证：`cordis` preset 在 `FULL_PRESETS`(:14) 与 `rpc-policy.ts:230` 显示名「插件开发」中；`dsh-tool-cordis` 在 0.1.6 仍存在（包未删，是 preset 组合内容变了）。
- 修复方向：Creator 模式的产品语义重定义——评估保留 `cordis` preset（变为 Plugin Manager 入口）还是收敛显示名；UI 文案「插件开发」按新语义复核。

### 2.4 模型路由

**DeepSeek 默认改用 Messages 协议（Anthropic 式），支持 Files API 复用图片；自定义 API 地址保留不变——语义无歧义点待证：自定义 baseURL 下协议是否仍切换。**

- 实证命中：`infra/linux/config/settings.production.yaml` `llm-deepseek.baseURL: https://api.commandcode.ai/provider/v1`（第三方 relay，非官方端点）；`dsh-lark-deepseek-routing` 是 wire-ID 委托包装（`packages/llm/deepseek-routing/src/index.ts:39-71`），协议变化在官方 adapter 内部、包装层自动继承。
- 风险：若 0.1.6 对自定义 baseURL 也切 Messages 协议，`/provider/v1` relay 必须支持 `/v1/messages`，否则全量 DeepSeek 请求失败；「连官方端点时随请求上报会话事件」与我们无关（非官方端点），但升级时仍应显式关闭验证。
- 默认模型列表移除 `V4 Flash`/`V4 Flash Vision Exp`：我们目录是 `deepseek-v4.1-flash`（V4.1），名称不同但升级时必须实测条目仍在。
- 修复方向：升级候选上先对 relay 做最小 Messages 协议探测（`/v1/messages` 可达性），不通过则在 adapter 层固定旧协议或换 relay 端点；同步验证 `resolveModelInfo` 的 `reasoningEfforts` 元数据在新协议下仍下发（R58 桌面强度滑条依赖它）。

### 2.5 组合与安全边界

**插件依赖解析改运行时解析 + 支持运行时卸载；新增插件管理页（安装/配置/实时启停）。**

- 实证：本仓库插件以 cordis.yml + overlay patch 组合（`infra/linux/overlays/*.production.yml`、`apps/*/cordis.yml`），`.mjs` 插件走源码加载（如 liangshen `tool-bootstrap.mjs`）。
- 风险与决策：① 运行时解析/卸载改变 cordis 加载语义，overlay patch 的「行 id 整体替换」假设需重验；② **插件管理页是供应链面**——页面装插件=运行时引入未审计代码，与本仓库「技能是供应链输入」纪律冲突，生产必须明确禁用或收敛到只读；其 RPC 入口应进 `rpc-policy.ts` 白名单审计。
- 修复方向：升级时验证 patch 语义不变；插件管理相关官方行在生产 overlay 显式 `disabled: true`（先例：`ui-sidebar-files`）。

**Web 用户终端使用系统用户权限，不受 Agent 沙箱模式限制。**

- 影响：web 终端以 dsh 系统用户在**宿主**执行，绕开 OCI——与「执行只发生在 worker/OCI 边界」硬边界冲突。
- 决策（升级时落实）：确认该功能挂载行并在生产 overlay 显式禁用；若未来要开，需独立的安全评估（它等价于给每个登录用户一个宿主 shell）。

**配置热更新取消事务回滚：解析失败保留原配置，激活失败可能部分生效。**

- 运维影响：`settings.production.yaml` 热改的失败面从「整体回滚」变「可能半生效」；生产纪律改为改配置必重启服务，不依赖热更。

**侧边栏大扩展**（Office 预览/URL 浏览器/Subagent 会话/提交计划/终端/布局持久化）+ 官方 `ui-sidebar-*` 包在 0.1.6 全在。

- 实证：我们 R53 禁了 `ui-sidebar-files`（官方 Files 与 better-sidebar 重复），品牌插件锚 `data-dsh-panel-host`/`_panel`/`toggleCluster`/`_titleRow`/`_handle`/`data-sidebar-collapsed`（0.1.6 起由 AppFrame 发布在布局 frame 上，替代 0.1.5 的 `body[data-dsh-sidebar-collapsed]`）。
- 已修复（R59 后回归修复）：旧 `body[data-dsh-sidebar-collapsed]` 选择器恒不匹配导致移动菜单键永久隐藏——改锚 `data-sidebar-collapsed` 并以 `MutationObserver` 兜底全部收起路径；右坞去重、顶栏收纳等 aria-label 锚点同步改为 locale 无关选择器（详见后文实施记录）。
- 修复方向：重新评估 better-sidebar `0.19.1` 与官方新侧栏的功能差（官方已有终端/浏览器页签，差距在缩小）；`ui-sidebar-files` 去重决策按新功能面重审。

### 2.6 其余已核实

- **不命中**：`agent/session-start`（0 命中）；E2B 后端未使用；`dsh <profile>` CLI 与本部署无关；`process.env` 写入门禁已有（verify-plugin-boundaries.mjs）。
- **修复受益**：子代理完成通知仅传正文（修父请求被推理块打挂——疑似我们此前见过的上游失败类根因）；重启后 Inbox 消息恢复；重复申请有效权限模式不再审批；会话被其他实例占用时明确提示；Messages API 拼接/历史工具输入格式修复。
- **会话格式**：0.1.5 升过 v3；0.1.6 notes 未提格式代际变化，升级时仍需对冻结副本做全量只读恢复核验（沿袭 0.1.5 迁移门禁流程）。

## 三、修复计划（按阶段，全部在 master 上走分支合入）

### Phase 0 现在可做（不阻塞主线）

- 本文档入库；跟踪 `0.1.6-rc.x` 发布。
- `upstream/dsh-desktop` pin 独立 bump `5510cb1→a934d988`（desktop-dev 车道，吃 Windows 修复与侧栏锚定，与内核升级解耦）。
- `dsh-better-sidebar` 0.18.0→0.19.1 可在当前 0.1.5 基线上独立评估（peer `^0.1.5-rc.1` 兼容），顺带验证冷会话 `persistence.inspect` 缺口是否修掉。

### Phase 1 接口适配（升级分支）

1. `dsh-sandbox-oci`：`confine`/`ShellExecutor.start` 改可取消异步，移植 R57 语义，补取消不留孤儿容器用例。
2. `desktop/workspace/journal.ts` 弃用 API 替换；`agent-bootstrap` 垫片验证。
3. `rpc-policy.ts` 对照 0.1.6 客户端方法目录重审白名单。
4. liangshen/standard 系 preset：PTC/workflow/ralph/subagent 行按新包名与语义重挂；`policy.ts` 的 `ptc`/`cordis` 条目同步。
5. deepseek relay Messages 协议探测 → 定 baseURL/协议策略；`deepseek-v4.1-flash` 目录存在性实测。

### Phase 2 组合与安全

6. 插件管理页/Web 终端/运行时卸载相关官方行：生产 overlay 显式禁用 + rpc-policy 审计。
7. Creator（cordis preset）语义重定与 UI 文案。
8. better-sidebar vs 官方侧栏功能面重审（去重决策、mediaLimit 配置迁移）。

### Phase 3 验证与发布

9. 新 UI 上品牌锚点全量重验（含移动端 media 规则）。
10. 会话格式冻结副本全量只读恢复核验（沿袭 0.1.5 门禁）。
11. 四模式 × 四语言 e2e、侧栏大文件流式、OCI 生命周期、移动端几何回归。
12. 候选金丝雀 → 生产灰度；回滚预案沿用「不切旧 release 覆盖新数据」纪律。

## 四、风险登记

| 风险 | 级 | 缓解 |
| --- | --- | --- |
| relay 不支持 Messages 协议 → DeepSeek 全断 | 高 | Phase 1.5 探测先行；失败则固定旧协议或换端点 |
| 插件管理页成供应链缺口 | 高 | 生产显式禁用 + RPC 白名单 |
| Web 终端绕 OCI 边界 | 高 | 默认禁用，开启需独立评估 |
| PTC/workflow 改名 → liangshen 挂不上 | 中 | Phase 1.4 重挂 + 组合测试钉住 |
| 会话 API/slot 变化 → 侧栏 cwd/品牌锚失效 | 中 | Phase 1.3 + Phase 3.9 |
| alpha 线持续流动，评估过期 | 低 | 以 rc.x release notes 为准重跑本文清单 |

## 五、实施记录（`upgrade/dsh-0.1.6-alpha.2`）

### 依赖面

- 全部 219 个 `@deepseek-ai/*` spec `0.1.5-rc.2 → 0.1.6-alpha.2`；registry 盘点 216/219 有 alpha.2，缺的 3 个正是改名前旧包（`dsh-code-runtime{,-node}`→`dsh-ptc-runtime`、`dsh-workflow-worker-thread`→`dsh-workflow-ptc`），停在 0.1.5 为预期。
- `dsh-better-sidebar 0.18.1 → 0.19.1`（peer `^0.1.5-rc.1` 覆盖 alpha.2）；组合测试断言同步。

### 接口适配（§2.1/§2.2）

- `dsh-sandbox-oci`：`confine`/`ShellExecutor.start` 改可取消异步签名（`runtime.ts`）；confine 内 await provision 探测结果，顺带修复旧版「探测未完成的假阴性拒绝」；R57 容器名冲突回收与 binding 失败逐出语义原样保留。新增「探测中 confine 等待」「abort 路径」用例；包测试 43/43 绿（含真机 provision→exec→dispose 零残留）。
- `journal.ts` → `SessionProjectionRegistry`：注册 host-only `desktopWorkspaceState`（`WorkspaceState | null`，`stateVersion: 1`，zod 边界校验 owner/mode/generation）；`read()` 走 `ctx.sessionProjections.stateOf()`，写路径保留事件 append + `ctx.sessions.flush` 不变（fail-closed 语义不动）。四个测试文件装配 registry；`desktop-workspace` inject 增 `sessionProjections`。
- `agent-bootstrap.ts`：registry 已是主路径，删除 deprecated `snapshotEvents` fallback（保留 `.events` 测试替身路径）。
- **显式例外**：liangshen `tool-bootstrap.mjs` 保留 `snapshotEvents()`——状态机含非 JSON 字段（`presentationDisposer` 函数）且冷重建语义微妙，官方允许 existing logic 保留，属有记录的兼容性例外。
- `model-seat`：`subagentAddress` 在 0.1.6 移到 client 端 sessions 集合，改经 `ctx.sessions` 以 `ISessions`（`dsh-api-session-controller/client`）类型化访问；顺带清掉该包 strict 模式类型债（`El.props` 非空化、`as unknown as El`、`SeatDomApi` portal），typecheck 归零。

### RPC 白名单重审（§2.2）

- 对照 0.1.6 全量 slash/dot 方法表 diff：`session/follow`、`goal/activation-changed` 等新增 scoped emit 进白名单；`workspaceFiles`/`officeToPdf` 的 `workspaceFileScopeId` 入归属提取链。
- mux 流过滤：`observeRemoteMuxClientFrame` 对 open/control 帧按流类型校验归属，拒绝流合成 error 帧显式失败（不静默悬挂）；`session/follow` 专属语义，测试帧带真实归属参数；`maskedTextFrame` 补 16 位扩展长度。

### preset 适配（§2.3）

- liangshen `agent.cordis.yml`：行 id `workflow-worker-thread → workflow-ptc`（对齐上游 standard）；`tool-subagent` 补 `modelSelectionSettings: true`（上游 standard 同项）。
- 包名残留：`workflow-worker-thread`/`code-runtime` 引用清零；`tests/composition.test.ts` 同步断言。

### 模型路由（§2.4）

- Relay 探测：`https://api.commandcode.ai/provider/v1/messages` 返回 401 Anthropic 错误格式（端点存在，非 404）——自定义 baseURL 下 Messages 协议可用。
- `settings.production.yaml` 显式钉 `protocol: messages` 固化决策；`prompt-audit-model` 测试 mock 重写为 Messages SSE 序列（`message_start`→`content_block_*`→`message_delta stop_reason=end_turn`→`message_stop`），断言 `/v1/messages` + `x-api-key`。
- `session-telemetry-otel` 生产 overlay 显式禁用（FEEDBACK_ONLY 上报 deepseeksvc.com，R58 已在跑的存量面借升级收掉）。

### 组合与安全（§2.5）

- 生产 overlay 显式禁用：`terminal-controller`（Web 终端=宿主 PTY 绕 OCI）、`ui-sidebar-terminal`、`ui-plugin-manager`、`session-telemetry-otel`。
- **`plugin-manager` 宿主服务保留**（打包校验实证）：dsh-base 以 `profileContext` 条件激活该服务，自建 worker 无 profile-backed host 故永不激活；但官方 `cordis` preset 的 `tool-plugin-manager` 行非禁用、硬依赖它，禁服务会让整个 cordis preset 挂载失败（boot-check 实测 `agent-preset/invalid`）。浏览器写面由 `ui-plugin-manager` 禁用 + edge RPC 白名单不含 pluginManager 方法（fail-closed）双层收口。
- **cordis preset 本地遮蔽**：`agent-presets/cordis/` 复制官方 preset 仅 `tool-plugin-manager` 行置 `disabled: true`（与官方 standard/ptc 同处置）。同步发现 `includeShippedRoot` 默认 `true` 使内置根恒优先、配置根同名遮蔽失效——lightweight/full/web patch 按 oci 先例补 `includeShippedRoot: false`（官方根显式列最后兜底，roster 不变仅改同名优先级）。
- `worker.production.yml` `sandbox-oci network: bridge` 断言修正（`network: none` 断言是测试过期，bridge 是刻意决策：容器出网装依赖、入站仍闭）。

### 核验证据

- `pnpm verify` 全绿：258 测试文件 / 1626 用例通过、typecheck 0 错、lint、官方完整性（迁移期补丁豁免 0 项）、插件边界、工具 schema、capability matrix、`git diff --check`。
- boot-check 实证：lightweight/full 两 profile 下 lark-lightweight/lark-standard/cordis/liangshen/standard/ptc/minimal 七 preset 全部挂载。
- 会话格式：`SESSION_FORMAT_VERSION = 3` 两代相同，无迁移；冻结副本核验——8 个生产 v3 会话（zstd）在 0.1.6 持久化层只读恢复 421 事件全解码、sha256 前后一致零写入；迁移套件 23/23 绿。
