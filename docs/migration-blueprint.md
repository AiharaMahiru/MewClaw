# Lark Claw → dsh-lark 迁移蓝图

状态：**完成——M0–M5 全部里程碑 + 真实飞书全链路验收通过（evidence/m5-feishu-acceptance.md）**。本文档是迁移期间的最高决策依据；与它冲突的实现一律回改。
组件级映射见 [component-map.md](component-map.md)。

## 1. 目标与范围

把 `D:\AI\lark-claw`（Pi Coding Agent 驱动的飞书卡片机器人平台，约 3.6 万行 TypeScript）迁移为 `D:\AI\dsh` 下的 **dsh-lark**：同一产品目标（多用户沙箱隔离、私有/共享 RAG、声明式机器人模板），底层运行时从 Pi 换成 DeepSeek Harness（dsh），遵守 **一切皆插件**（Cordis）理念，并借迁移修复原实现中与框架重复的结构性债务。

**范围内**：全部 lark-claw 组件重新规划（网关、worker、RAG、cron、记忆、沙箱、管理面、技能、模板、部署工具）。
**范围外**：

- 修改 dsh 框架源码（本仓库是插件仓库，dsh 是 npm 依赖）；
- 保留 Pi 专属抽象（`pi-runtime`、`UiEvent` 联盟、Pi SDK 会话工厂、Pi 子智能体编排器全部删除）；
- 承诺生产隔离 / 多租户安全达标（与 lark-claw 相同，逐阶段验收，不提前宣称）。

## 2. 现状盘点

处置细节见 [component-map.md](component-map.md)，此处只记规模与职责。

| 组件 | 行数（约） | 职责 |
| --- | --- | --- |
| `apps/lark-gateway` | 4700 | 飞书 WS 入口、去重、卡片、cron 控制、附件、交互卡 |
| `apps/pi-worker` | 3200 | Pi 会话执行、HTTP/NDJSON 运行 API、cron 执行 |
| `apps/admin-api` / `admin-web` | 3000 | 知识与机器人管理面 |
| `packages/pi-runtime` | 8700 | Pi SDK 适配、会话、工具、子智能体、视觉路由 |
| `packages/contracts` | 1100 | Scope、契约、事件类型 |
| `packages/lark-adapter` | 2100 | 飞书 SDK、卡片、WS 事件 |
| `packages/memory` | 900 | mem0 记忆 + outbox |
| `packages/sandbox` / `sandbox-mcp` | 1800 | OCI(Podman) 沙箱 + MCP |
| `packages/postgres-runtime` | 1200 | 便携 PG/pgvector/pgweb 运行器 |
| `packages/service-runtime` | 800 | Windows 服务 supervisor |
| `skills/rag` | 3500 | RAG 摄入/检索/可视化 |
| `skills/cron` | 1400 | PG 调度、租约、outbox |
| `skills/web` / `generate-image` / `lark-cli` / `cdg-bridge` | 2300 | 工具技能 |
| `skills/todo` | 500 | 自研 TODO |
| `bots/*`（规划中） | — | 机器人模板 |
| `infra/*`、`examples/lark-samples` | — | 部署资产、上游样例 |

## 3. 迁移原则

通用原则（SPEC 先行、证据驱动、能力缝纪律、不变量先行、失败闭环、最小可逆步、对抗性自查、显式优于隐式、类型即文档、模型可见⟺落盘）见 [thinking-framework.md](thinking-framework.md)；规则层见 [AGENTS.md](../AGENTS.md)。本节只记录**迁移特有**原则：

1. 一切皆插件：新行为落在插件或既有扩展点，每个能力按 Definition / Provider / Consumer 三角色组织。
2. 宿主面 / 会话面分离：注册表、沙箱、审批、持久化、模型路由在宿主组合；每会话内容走 agent preset 的 isolate realm。
3. 安全不变量不因迁移弱化（AGENTS.md 硬边界清单）。
4. 代码精简、可读、完善中文注释；轻量便携——依赖按预算管理，运行只需 Node + 便携 PostgreSQL（不强制 Docker）。

## 4. 关键架构决策（ADR）

### ADR-1 仓库形态：独立插件仓库

`D:\AI\dsh` 是独立插件仓库，dsh 经 npm 依赖引入（锁定 `0.1.0-rc` 系列精确版本，M0 时确定并写入 `pnpm-lock.yaml`）。本地开发用 pnpm workspace + 自有 app bins（`apps/lark-gateway`、`apps/lark-worker`）从源码经 tsx 启动 cordis 组合；分发时包名为 `dsh-lark-*`（沿用 dsh-cc-tui 生态惯例，可被 `dsh plugin add` / bundle patch 安装）。

**理由**：与 lark-claw 依赖 pi 的方式对称；不承担框架仓库门禁；DSH 官方明确插件仓库是生态形态。
**开放问题**：发布作用域（`@deepseek-ai` 作用域需要组织权限；备选自有作用域、私有 registry、或 file: 安装）——见 §9。

### ADR-2 数据面：DSH session log 接管会话

会话 / 运行生命周期 / 事件流由 DSH 的 `dsh-session` + `dsh-session-persistence-jsonl` + `dsh-session-query-sqlite` 承载；worker 不再维护自研会话/运行元数据表。PostgreSQL 仅保留四张面：知识库（pgvector）、cron 任务与投递 outbox、审批待办恢复、管理面数据。

**收益**：删除 `ScopedSessionService`、自研 run 元数据、`UiEvent` 联盟；"模型可见 ⟺ 已落盘"由框架保证；卡片渲染器直接消费 session 事件流。
**约束**：飞书专属事件（`knowledge.citations`、`artifact.created`、`approval.requested` 等）在 `dsh-lark-contracts` 中以声明合并加入 `SessionEventMap`，必要时携带 `ignorable` 信封，随 DSH 的 `SESSION_FORMAT_VERSION` 机制演进。

### ADR-3 进程拓扑：双进程保留，各自一份组合

网关进程（飞书面）与 worker 进程（执行面）保持独立部署单元。网关 cordis.yml 只挂 lark 客户端、卡片渲染、审批 provider、命令与控制面（不挂任何工具）；worker cordis.yml 挂 agent 栈（agent-loop、llm、tools、subagent、sandbox、knowledge、cron、memory）。两者通过 worker 暴露的窄 HTTP/NDJSON 桥接通信（ADR-4）。

**理由**：飞书面永不执行工作区工具是 lark-claw 硬边界；dsh 插件组合恰好让两个进程共享同一批包、不同组合。

### ADR-4 桥接协议：session 事件直出 NDJSON

worker 上的 `dsh-lark-run` 插件暴露 `POST /v1/runs`（入参：完整 Scope + 用户消息；响应：`application/x-ndjson` 的 **DSH session 事件流**，含心跳空行）与 `/v1/cron-control`、`/v1/session-overview` 等窄控制端点。会话查询用完整 Scope + generation 确定性派生 sessionId，不接受客户端提供任意 sessionId。网关校验每个事件的 runId 与完整 Scope 后驱动卡片渲染。共享 Bearer token 沿用 lark-claw 语义（M5 换工作负载身份）。

**理由**：不发明第二套事件协议——session log 已是版本化、可重建的事件源；M5 评估收敛到 dsh SDK（typert/api-gateway）后此插件退化为传输适配器。
**保留语义**：空回复（无可见文本/产物）→ 网关替换处理卡；运行级超时/无进展窗口/硬上限；per-scope 串行队列。

### ADR-5 机器人模板 = DSH agent presets

`bots/<slug>/`（bot.yaml + system.md + cards + knowledge）重构为 agent preset 目录：`preset.yml`（元数据）+ `agent.cordis.yml`（persona、system prompt 插件行、工具行、技能行）。平台强制策略与租户策略位于**常驻 bundle 层**（`dsh-lark-base` 的 cordis.patch.yml），preset 无法覆盖；每会话挂载的 preset 行进入 isolate realm（entry-local），天然获得 per-scope 实例隔离。bot 版本化 = preset 目录版本化；每次运行记录 preset 修订 + 技能摘要 + 模型身份（写入 session 元数据）。

### ADR-6 隔离：realm × 每 Scope 会话 × 显式执行 profile

- **会话隔离**：Scope（tenant/bot/deployment/user/conversation）→ 稳定 sessionId 映射 + 独立工作目录（沿用 `.workspaces/<scope-hash>` 语义，由 fs policy 限定）。
- **服务隔离**：per-scope 的可变服务（persona、指令、技能集）经 preset isolate realm 每会话独立实例；宿主面注册表共享但按 owning agent 分键（DSH jobs/tools 既有语义）。
- **默认轻量 profile**：`apps/lark-worker/lightweight.overlay.yml` 禁用本机 subprocess、shell、jobs、基于 subprocess 的文件搜索、permission 命令面、子代理、workflow 与 Ralph；只保留经 `dsh-fs-sandbox` 限定到 Scope 工作区的文件能力，以及知识、cron、问卷和受信 Provider。它是 **capability-restricted host profile**，不是 OS 级 sandbox，不允许任意代码执行，也不宣称隔离主机读取、网络或进程可见性。
- **可选 full profile**：需要本机 Shell、文件搜索、jobs、委派或官方执行型 preset 时，显式设置 `DSH_LARK_ISOLATION_PROFILE=full`；supervisor 加载 `apps/lark-worker/full.overlay.yml`，使用宿主本机执行组合，并暴露飞书全功能模式以及官方 `standard`、`code`、`minimal`、`cordis` 四个 preset。该 profile 不是 OS 级 sandbox。
- **可选 OCI profile**：需要 shell、编译、任意代码或子进程时，显式设置 `DSH_LARK_ISOLATION_PROFILE=oci`；supervisor 加载 `apps/lark-worker/oci.overlay.yml` 并维护 Podman。`dsh-sandbox-oci` 提供 rootless OCI、读写根、降权、CPU/内存/PID/tmpfs、单挂载和默认断网。
- **选择不变量**：profile 只允许 `lightweight | full | oci`，缺省为 `lightweight`，未知值启动失败。supervisor 必须把对应 overlay 作为 worker 参数传入；状态面记录 profile，不能把目录分离或 Windows ACL 写限制称为完整 sandbox。

### ADR-7 审批 = DSH 交互能力 + 飞书卡片 provider

`approval.requested` 事件与自研交互存储退位：模型侧走 dsh 的 `userInteraction` 能力（`tool-ask-user` / user-questions），`dsh-lark-approval` 作为该能力的**飞书交互卡片 provider**（发送卡片问卷、消费 card.action.trigger 回调、超时/非码过期）。旧 PG 待办恢复没有迁移，不宣称跨重启 at-least-once。模型发起的问卷在飞书端渲染为交互卡。

### ADR-8 知识 = 新 knowledge 能力（PG+pgvector provider）

`skills/rag` 的检索/摄入逻辑重构为能力缝：`dsh-knowledge`（Definition：摄入事务、ACL 查询内过滤、混合检索、引用）、`dsh-knowledge-postgres`（Provider：PG+pgvector、迁移、版本激活）、`dsh-tool-knowledge`（Consumer：模型侧 `knowledge_search`，Scope 来自运行信封而非模型参数）。`user_private` / `bot_shared` 语义、所有权与可见性分离、摄入事务、删除先不可检索——全部原样保留。知识库管理面由 `dsh-lark-admin` 提供。

### ADR-9 cron = 新跨会话 cron 能力

`skills/cron` 迁移为 `dsh-lark-cron` 能力（PG 存储、`FOR UPDATE SKIP LOCKED` 租约、执行历史、投递 outbox、跨会话管理）+ `dsh-tool-cron`（Consumer：自然语言建任务）。与 dsh 内建的 `dsh-schedule`（会话内提醒）**并存不合并**：两者生命周期域不同。网关裸 `/cron` 与控制卡回调走确定性控制端点（不经模型）；回调 payload 仅限固定命令 + UUID，job ID 永非所有权证据；创建仍留在模型侧（自然语言归一化）。

### ADR-10 记忆 = 新 memory 能力（mem0 provider，默认启用）

`packages/memory` 迁移为 `dsh-memory`（Definition：recall/remember，用户键 = 租户/机器人/部署/用户哈希）+ `dsh-memory-mem0`（Provider：mem0 OSS，PG+pgvector 同库）。旧独立 outbox 没有迁移。挂载失败/超时降级为无记忆聊天；mem0 依赖链沉重但 SDK 懒加载，整栈**默认启用，可显式关闭**。

### ADR-11 技能与供应链信任

受审技能以纯指引 Skill 经独立命名的 `dsh-skill-filesystem` Provider 发现，`dsh-skill-trust` 对目录 SHA-256、版本和能力声明精确预检，失败即拒绝加载。脚本式 `lark-cli` 和原 CDG 任意命令/MCP 面不迁移；`cdg-bridge` 重写为纯指引 Skill，只调用要求运行 Scope、限制在当前会话工作区的 `cdg_file`。附件管线继续通过 `dsh-cdg-bridge` 固定参数桥接。

### ADR-12 视觉 = 宿主视觉路由插件

主模型按 lark-claw 策略默认为 text-only；图片/扫描 PDF 经 `dsh-lark-vision` 插件路由到已注册的视觉模型路由（dsh `llm-pi-ai` / `llm` 能力），只把结构化文本回注给主会话；不可用时 fail closed。视觉模型注册进 llm 目录（不再有独立 VISION_* 客户端）。

### ADR-13 生产替换：DSH 是唯一运行架构

生产迁移后，对外请求只进入 DSH Web/Auth Edge、Gateway、Worker、Admin 与 Cordis 插件组合。DoorAgent 仅作为冻结数据源、回滚期只读实例和产品想法参考；其 Runtime、Web、API、SQLite 协议、Pi JSONL 协议与 Evolution 代码都不成为 DSH 的运行时依赖。DSH 在独立目录和专用非 root 服务账户下发布，通过入口切换替换 DoorAgent，不在原目录原地覆盖。

用户和关联数据只能经 DSH 的 Definition/Provider/Consumer 能力缝迁移。用户以稳定源映射和规范化邮箱合并；关联数据必须有唯一所有权与完整 Scope，无法证明归属的对象只归档或拒绝。会话正文没有官方可写 session event 契约时只做带摘要的只读归档，不能直接写内部表。切流前完成不可变快照、dry-run、对账和回滚演练；切流 epoch 存在业务增量时保持双方只读并先对账，禁止盲目恢复旧端写入。

本地 DSH `.env` 只有在 `.codex-tasks/20260824-dsh-replace-dooragent/` 生产迁移中可由部署面原字节传输。代理不得读取、解析或回显内容；源和目标只比较 SHA-256，目标权限收敛到 DSH 服务账户最小可读，且文件不得进入 Git、构建产物、日志或证据。DoorAgent `.env` 不属于该例外。

**理由**：保留 DoorAgent 运行依赖会形成双架构、双权限和双数据所有权；原地覆盖会破坏回滚证据。独立发布、能力缝导入和入口原子切换能保持 DSH/Cordis 生命周期、Scope、沙箱与审计不变量。

## 5. 目标仓库布局

```text
D:\AI\dsh\
  package.json                  pnpm workspaces（packages/*、apps/*、skills/*）
  pnpm-workspace.yaml
  docs/                         architecture、threat-model、蓝图、组件映射
  docs/reference/               DSH 参考文档（cfg_zh.md、dsh_readme2.md、cc_tui_readme.md 移入）
  packages/                     全部 @deepseek-ai/dsh-lark-* 插件包（见 component-map.md）
  apps/lark-gateway/            飞书网关部署 bin（cordis.yml）
  apps/lark-worker/             执行 worker 部署 bin（cordis.yml）
  apps/admin-api/               管理面部署 bin
  apps/admin-web/               管理前端
  presets/<slug>/               机器人模板（agent preset 目录）
  skills/                       受审技能源（trust-manifest.json + 各技能）
  infra/postgres/               便携 PG/pgvector/pgweb（自 lark-claw 迁移）
  infra/sandbox/                OCI 镜像构建与烟雾脚本
  infra/windows/                Windows 服务 supervisor（自 lark-claw 迁移）
  tests/                        集成/安全/e2e 验证
  var/ .workspaces/ .uploads/   运行态目录（语义不变，均 git-ignored）
```

（上游飞书样例 `examples/lark-samples` 最终未引入本仓库——参考材料留在 lark-claw。）

## 6. 运行时拓扑

```text
飞书用户
  → [网关进程] dsh-lark-gateway（WS 长连接、去重、授权、会话协调、卡片渲染、审批 provider、命令）
        │  POST /v1/runs（Scope + 消息）── NDJSON session 事件流 ──┐
        ▼                                                          │
  [worker 进程] dsh-lark-run（per-scope 队列、超时、取消）          │
        → dsh agent-loop（agent preset isolate realm 挂载）        │
             → profile-gated tools + knowledge + cron + optional memory
             → lightweight（默认，禁任意代码）、full（显式本机执行）或 dsh-sandbox-oci（显式 Podman）
        → session log（JSONL + SQLite 查询）
```

两进程的具体行集（平台强制层 / worker 层 / 网关层）见 [bundles.md SPEC](specs/bundles.md) §4——组合行集以 SPEC 为唯一 home，此处不再复述。

## 7. 配置面

lark-claw 的 `.env` 变量按四类处置：

| 类别 | 处置 | 示例 |
| --- | --- | --- |
| `.env` 文件本身 | 默认不读取、不复制、不迁移；唯一例外是 ADR-13 授权的本地 DSH 生产迁移，只允许不回显的原字节传输、SHA-256 一致性和最小权限验证 | 仅代码中的凭证引用名可版本化；DoorAgent `.env` 不迁移 |
| 密钥 | 凭证引用（`ctx.credentials`，env 名入引用；值绝不入配置/日志/文档） | `LARK_APP_ID/SECRET`、`DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY`、`FIRECRAWL_API_KEY` |
| Pi 专属 | 删除 | 全部 `PI_*`（模型、沙箱、技能、超时、worker token） |
| 部署可变项 | 各插件 Config 字段（cordis.yml 可写，默认值显式解析） | 端口、允许列表、上传根、超时档位、并发上限、cron 轮询间隔、mem0 开关 |

模型策略：`PI_PROVIDER_ID/PI_MODEL/PI_BASE_URL` 消失；主模型走 `dsh-llm-deepseek`（或 `dsh-llm-pi-ai` 路由到 OpenAI 兼容端点），视觉模型注册为 llm 目录中的图像路由（ADR-12）。`LARK_ALLOWED_CHAT_IDS` / `AUTHORIZED_OPEN_IDS` 保持网关 Config。`.env` 仅作本地开发密钥源：代码不直接 `require('dotenv')` 读值，值经凭证引用（env 变量名）由 `dsh-credentials-local` 的项目 `.env` 回退读取。

## 8. 阶段计划

### M0 仓库骨架与依赖锁定（1 个里程碑）

- pnpm workspace、tsconfig、eslint、vitest 就位；锁定 `@deepseek-ai/dsh-*` 精确版本并冒烟加载最小 cordis.yml；
- 文档骨架（蓝图 / 组件映射 / 思维框架 / SPEC 标准 / 15 份 SPEC）与参考归档（`docs/reference/`）、本仓库 AGENTS.md 已就位；`.env` 值不进入迁移流程；
- `infra/postgres`、`infra/windows`、`infra/sandbox` 从 lark-claw 平移（不依赖 Pi 的部分）；
- git init，lark-claw 保持不动（迁移基准）。

**验收**：空组合启动/关闭干净；`pnpm test/typecheck/lint/build` 全绿；与 lark-claw 的 Git 基线建立映射。

### M1 单用户垂直切片（核心里程碑）

工作项：`dsh-lark`（客户端）、`dsh-lark-gateway`、`dsh-lark-run`、`dsh-lark-card`、`dsh-lark-commands`、`dsh-lark-contracts`、两个 bundle、两个 app bins；飞书文本进 → 授权 → DSH agent 会话 → session 事件流 → markdown 卡片流式渲染；取消、超时、`/clear`、一个交互卡审批动作；会话持久化（session log）。

**复用**：dsh-base 的 agent-loop/session/llm/tools/system-prompt 等基础行；默认 lightweight overlay 再移除 bash/subprocess/subagent/jobs/workflow 等任意执行能力。
**验收**：真实飞书用户多轮会话；卡片更新有序、节流、可重试恢复；重启恢复会话元数据且不重放工具副作用；全套静态门禁 + 飞书烟雾。

### M2 多用户隔离

- Scope→sessionId 映射、事件去重、per-scope 串行（`dsh-lark-run` 队列）；
- 默认 capability-restricted profile + 可选 `dsh-sandbox-oci`（Podman）+ 能力预检 + 资源/期限/清理/网络策略；
- `dsh-skill-trust` 供应链预检上线；审计记录。

**验收**：轻量 profile 不暴露任意代码/子进程能力，Scope 工作区跨用户拒绝；OCI profile 的路径/符号链接/进程/挂载/网络/密钥/清理测试通过；终止与主机重启产生确定性可恢复状态；两种 profile 的能力声明与实际组合一致。

### M3 私有与共享 RAG

- `dsh-knowledge` + `dsh-knowledge-postgres` + `dsh-tool-knowledge`；
- `user_private` / `bot_shared`、混合检索（词法+向量，ACL 查询内过滤）、引用、重索引；
- 附件摄入管线（`.uploads` 语义保留，CDG 桥接前置检查）；
- `dsh-lark-admin` + admin-web 知识管理面。

**验收**：跨用户/机器人/租户检索拒绝测试；删除/被取代内容事务提交后不可检索；答案暴露来源与版本；索引失败不留半可见文档。

### M4 机器人模板与技能

- presets 目录化 + `bot:new` 生成器 + 部署预检；信任技能解析与能力推导；
- coding-assistant / knowledge-assistant 参考模板；
- cron 完整上线（执行、租约恢复、投递 outbox、`/cron` 管理卡）；memory 默认启用（mem0 provider，可显式关闭，无独立 outbox）。

**验收**：不改运行时源码即可新建机器人；越权模板部署前失败；模板/技能变更产生版本化修订；每次运行记录模板修订与技能摘要。

### M5 生产加固

- 结构化日志/指标/配额/保留/备份；管理面运营功能；
- 飞书重复事件、限流、卡回调过期、断连演练；迁移/备份恢复/崩溃恢复演练；
- 桥接协议评估收敛到 dsh SDK（ADR-4）；依赖/许可证/密钥/镜像审计；
- Windows 服务 supervisor 对接新 bins；发布通道（npm 作用域/registry）落地。

**验收**：发布清单逐门禁有宿主观测证据；无高危/严重安全发现；负载/延迟目标显式记录；干净环境演练回滚与恢复。

## 9. 风险与开放问题

| 项 | 说明 | 缓解 |
| --- | --- | --- |
| dsh 0.1.0-rc 阶段 API 不稳定 | 插件将随 rc 破坏性变更升级 | M0 锁精确版本；升级窗口作为 M 阶段的前置任务；每个包声明对 dsh 版本的依赖范围 |
| `@deepseek-ai` npm 作用域发布权限 | 独立仓库发布到该作用域可能无权限 | 自有作用域 / 私有 registry / `file:`+git 依赖分发；M5 落地；本地开发不受影响（app bins 直接源码启动） |
| 飞书专属 session 事件与 `SESSION_FORMAT_VERSION` | 自定义事件需声明合并 + ignorable 信封 | `dsh-lark-contracts` 集中声明；快照测试覆盖事件重放 |
| mem0 依赖重（openai/zod 等） | 增加供应链面 | 当前默认启用并保持懒加载；可显式关闭，运行期失败降级为无记忆 |
| pgvector 便携构建（Windows） | 沿用 lark-claw 的 EnterpriseDB + 自编译 pgvector 流程 | `infra/postgres` 整体平移，不动 |
| cdg-bridge 二进制（按平台） | 宿主附件管线与模型工具的供应链、授权和多用户隔离 | 版本化绝对路径；模型仅经 Scope 工作区包装工具调用；不挂载原始 MCP；不可判定时拒绝附件 |
| 双进程桥接可靠性 | 心跳、at-least-once 投递、事件重放一致性 | ADR-4 语义原样保留（心跳空行、投递确认、空回复替换）；M5 演练 |
| 行为变化：TODO | 自研 PG TODO 被 DSH tool-todo（会话本地）取代 | M1 明确记录为行为变更；管理命令 `/todo` 降级为会话视图 |

## 10. 迁移边界（不做什么）

- 不改 dsh 框架源码；发现框架缺口先在本仓库以插件补位，并向上游提 issue。
- 不迁移 Pi 专属逻辑：Pi SDK 会话工厂、Pi 子智能体编排器、Pi 运行时配置、`UiEvent` 联盟、Pi 技能信任加载器。
- 不读取、复制或迁移 lark-claw/DoorAgent 的 `.env` 值；DSH 本地 `.env` 保持 git-ignored，只有 ADR-13 的生产迁移例外允许不回显的原字节传输，值仍不得进入源码、构建产物、文档、日志、卡片或事件。
- 不迁移 `lark-cli`、原脚本式 `cdg-bridge`/原始 MCP、成员查询工具或旧 `/handoff <goal>` 任务语义；CDG 与生图仅通过已立 SPEC 的受控工具面提供。
- 不把 `examples/lark-samples` 当作产品架构来源（与 lark-claw 同规则）。

## 附录 A：lark-claw ADR 存续判定（完善清单 R-12）

lark-claw `docs/adr/` 四份 ADR 的处置：其决策语义仍有约束力者在此登记存续，失效者注明原因；原文留在 lark-claw 仓库，不再复制。

| ADR | 判定 | 说明 |
| --- | --- | --- |
| 0001 嵌入 Pi Node SDK | **失效** | 运行时已整体换为 dsh（本蓝图 ADR-1..3 的对偶决策）；"适配层收敛 SDK 版本扰动、其余包只消费产品契约"的纪律以 contracts/能力缝形态存续 |
| 0002 网关与隔离 worker 分离 | **存续** | 三进程拓扑（网关无工具行 + worker 执行面 + admin 无 agent 栈）继承并加固：组合校验测试锁死行集硬边界；本地 lightweight profile 对应其"仅可信开发、须标注非安全"条款——不称沙箱、不满足生产沙箱验收 |
| 0003 RAG 按 Scope 查询期过滤 | **存续** | `dsh-knowledge-postgres` 检索谓词内 ACL（词法/向量同语义测试）；换向量库必须先证明等价的查询期过滤 |
| 0004 版本化声明式 bot 模板 | **存续（形态演化）** | presets 目录（preset.json：version/revision/技能清单/persona）+ `dsh-lark-presets` 装载校验 + `lark/run/preset` 落盘；不可变平台政策在 bundle 层（模板外）不变；"任意用户技能不在信任范围"由 trust-manifest + 预检 fail closed 承担 |
