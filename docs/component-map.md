# dsh-lark 组件映射

配合 [migration-blueprint.md](migration-blueprint.md) 阅读。本文档给出 lark-claw 每个组件 → 新仓库包的处置、新包职责清单、以及删除清单。

## 1. 总映射表

| lark-claw 组件 | 处置 | 目标包 / 位置 |
| --- | --- | --- |
| `apps/lark-gateway` | 重写为插件组 + 组合 bin | `dsh-lark-gateway`、`dsh-lark-card`、`dsh-lark-approval`、`dsh-lark-commands`、`dsh-lark-run-client`、`apps/lark-gateway` |
| `apps/pi-worker` | 重写为组合 bin，删除 Pi 集成 | `dsh-lark-run`、`dsh-lark-uploads`、`dsh-lark-vision`、`dsh-lark-image`、`dsh-tool-image`、`apps/lark-worker`；成员工具未迁移 |
| `apps/admin-api` | 迁移为宿主插件 | `dsh-lark-admin`、`apps/admin` |
| `apps/admin-web` | 迁移前端，适配新 API 契约 | `apps/admin-web` |
| `packages/pi-runtime` | **删除** | dsh core（见 §4 删除清单） |
| `packages/contracts` | 拆分 | `dsh-lark-contracts` + 各能力包自有类型 |
| `packages/lark-adapter` | 迁移重构 | `dsh-lark`（能力：客户端 + HTTP provider + WS 客户端 + 卡片元素） |
| `packages/memory` | 迁移并增强 | `dsh-memory`（Definition）+ 默认启用且可显式关闭的 `dsh-memory-mem0`（Provider）+ 持久化 write scheduler |
| `packages/sandbox` | 可选迁移 | `dsh-sandbox-oci` 仅供显式 OCI profile；默认 lightweight 不依赖 Podman |
| `packages/sandbox-mcp` | 简化 | 镜像构建→`infra/sandbox`；MCP 挂载→`dsh-mcp-client` 行 |
| `packages/postgres-runtime` | **保留**（平移） | `infra/postgres` |
| `packages/service-runtime` | **保留**（平移） | `infra/windows` |
| `packages/knowledge`（空目录） | 吸收 | `dsh-knowledge-*` |
| `skills/rag` | 重构 | `dsh-knowledge` + `dsh-knowledge-postgres` + `dsh-tool-knowledge` + 技能 `skills/lark-rag` |
| `skills/cron` | 迁移 | `dsh-lark-cron`（能力）+ `dsh-tool-cron` + 技能 `skills/lark-cron` |
| `skills/web` | 迁移 | `dsh-web-firecrawl`（web 能力 provider）+ 技能 `skills/lark-web` |
| `skills/lark-cli` | **不迁移** | 依赖任意 CLI/进程能力，与默认 lightweight profile 冲突；后续仅可在受审 OCI profile 重新立项 |
| `skills/cdg-bridge` | 重写为受控能力缝 | `dsh-cdg-bridge`（附件管线）+ `dsh-tool-cdg`（Scope 工作区模型工具）+ 受信纯指引 Skill；不挂载原始 MCP |
| `skills/generate-image` | 迁移为能力缝 | `dsh-lark-image`（Definition+Provider）+ `dsh-tool-image`（generate_image 工具）——生产与 GPT 文本模型共用 OpenAI 兼容入口和 `OPENAI_API_KEY`，模型为 `gpt-image-2`（SPEC image.md） |
| `skills/todo` | **删除** | dsh 内建 `dsh-tool-todo` |
| `bots/*`（规划中） | 重构 | `presets/<slug>/`（agent preset 目录） |
| `docs/*` | 重写 | 蓝图（ADR-1..12 + 附录 A：lark-claw ADR 存续判定）、映射、[threat-model](threat-model.md)；旧 architecture.md/development-plan 不迁移——架构决策归蓝图 ADR、威胁模型独立成文（完善清单 R-12） |
| `infra/*` | 保留 | `infra/` |
| `examples/lark-samples` | 不迁移 | 未引入本仓库（参考材料留在 lark-claw；不构成产品架构） |
| `.env` | **不读取、不复制、不迁移值** | 现有本地文件保持 git-ignored；代码只使用凭证引用与插件 Config（蓝图 §7） |
| `.env.example` | 删除 | 变量名清单进入各包 Config 与凭证引用 |

## 2. 新包清单

所有包遵循 DSH 惯例：ESM、`strict`、JSDoc 完整、注册走 `ctx.effect()`、能力缝 = Definition/Provider/Consumer。前缀 `dsh-lark-*` 为飞书平台专属；跨域能力（knowledge/memory）在仓库内定义同名服务。

### 2.1 契约与类型

**`dsh-lark-contracts`** —— 跨包共享的稳定类型，无运行时依赖。

- `Scope`（tenantId/botId/deploymentId/userId/conversationId，品牌化 ID 类型）；
- `RunRequest` / 运行控制契约（cancel、超时档位、队列策略）；
- cron 控制契约（固定命令 + UUID 校验）；
- `SessionEventMap` 声明合并：`knowledge.citations`、`artifact.created`、`approval.requested` 等飞书专属类型化事件（必要时 `ignorable` 信封）；
- 来源：`packages/contracts` 全部 13 文件。

### 2.2 飞书客户端（lark 域）

**`dsh-lark`** —— 飞书客户端能力。

- 角色：Service Definition + Provider + 配置。
- 服务：`ctx.lark`（应用访问令牌、消息收发、资源下载、WS 事件订阅、卡片更新、群成员读取）；
- Provider：官方 OpenAPI REST + WebSocket 长连接客户端（消费 APP_ID/SECRET 凭证引用）；
- 卡片元素模型（markdown 卡、交互卡、按钮/回调载荷），纯函数呈现；
- 来源：`packages/lark-adapter` 的 lark-sdk、inbound-message、lark-file、lark-resource、interaction-card、markdown-card。

### 2.3 网关域（宿主面）

**`dsh-lark-gateway`** —— 入口、身份、会话协调（核心插件）。

- 消费 `ctx.lark` + `ctx.larkRunClient`；WS 事件→授权→去重→Scope 引导→会话协调→把运行交给 worker；
- 保留语义：platform event/message 去重、allowlist、`EMPTY_RESPONSE` 替换、附件 staging（当前为进程内有界暂存，下条提示词领取）、cron 身份引导；
- 来源：lark-gateway 的 conversation-handler、scope-bootstrap、gateway-message-store、bot-menu-command、session-command。

**`dsh-lark-card`** —— 卡片渲染（session 事件消费者）。

- 把 DSH session 事件流映射为最小 markdown 回答卡 / 交互卡 / 结构化动作卡；流式缓冲、节流、重试；隐藏推理与密钥永不上卡；
- 来源：streaming-markdown、card-update-buffer、ephemeral-card-scheduler。

**`dsh-lark-approval`** —— userInteraction 的飞书卡片 provider。

- 消费 dsh 审批/问卷服务；发送交互卡、消费回调、超时与非码过期；旧 PG 待办恢复未迁移；
- 来源：interaction-store、interaction-command、conversation-interaction + pi-worker 的 questionnaire 工具（工具本身由 dsh tool-ask-user 取代）。

**`dsh-lark-commands`** —— 网关确定性命令服务（`ctx.larkCommands`）。

- 实际命令集：`/clear`（换新会话，代次递增）、`/handoff`（只读归属视图）、`/runtime`（运行档位读写）、`/todo`（会话视图）、`/session`（用量）、`/login`（Feishu 与 Web 一次性配对）、`/help`。lark-claw 的 `/cron` 管理命令已补齐为确定性命令，统一实现在本包（R-18 终态；曾并存于网关包的在途拦截实现已删除合并）：`/cron [list|<jobId>|pause|resume|delete <jobId>]`，走 worker cron-control 端点；卡片表单编辑与 `/preset` 不迁移——编辑 = 删除 + 自然语言重建）；
- 来源：cron-command、cron-management、todo-command、handoff-command、runtime-profile-command、session-usage-command、todo-management、feishu-web-pairing。

**`dsh-lark-run-client`** —— worker 桥接客户端（网关侧）。

- NDJSON 解析、心跳容忍、事件 schema 校验、重试与投递确认；来源：worker-client、ndjson、cron-delivery-poller、worker-cron-control、todo-worker-client。

**`dsh-lark-admin`** —— 管理面宿主插件（M3+）。

- 挂载于 dsh host-webserver；**当前范围仅知识管理**（快照/摄入任务/生命周期 API + admin-web 知识管理单页 + 健康检查）；浏览器 Scope 仅在此创建。映射目标中的"机器人模板管理、运行审计"**记录为有意缩小**（R-17 终态：运行观察走网关 `/session` 命令 + worker session-overview 端点；补管理面属 M6+ 范围，需另行立项）；来源：apps/admin-api。

### 2.4 执行域（worker 面）

**`dsh-lark-run`** —— 运行服务器与 per-scope 调度（核心插件）。

- `POST /v1/runs`：Scope 校验 → 队列（per-scope 串行、全局并发、每用户并发、排队上限）→ 挂载 agent preset（isolate realm）→ 流式 session 事件 NDJSON（含心跳）；
- 运行期限：无进展窗口 + 硬上限 + 档位（quick/standard/long）；取消经 agent abort；
- 空回复语义、cron 执行入口（共享同 scope 串行执行器）、控制端点（cron-control / session-overview / 交互）；`session-overview` 用完整 Scope + generation 只读折叠 DSH session log；
- 来源：scoped-run-executor、worker-api、http-server、ExecutionBudgetController、PiRunner 中的生命周期逻辑（Pi 部分删除）。

**`dsh-lark-uploads`** —— 上传对象根与附件管线。

- `.uploads` 根、SHA-256 校验、CDG 桥接物化、统一内容检测（图片视觉/文本富格式提取/未知二进制明示）、附件→提示词准备（内容块先落盘 `lark/run/context`）。lark-claw 的 `.artifacts` 复制存储与下载交付链**不迁移**；产物收集以事件形态补实现（R-06 终态：运行成功后 `collect()` 写 `lark/artifact/created`，网关产物行生效）；
- 来源：attachment-service、attachment-prompt-preparer、lark-claw 的 LocalUploadStore（workspace 产物收集见 R-06）。

**`dsh-lark-vision`** —— 宿主视觉路由。

- 工具/用户图片内容 → 视觉模型路由（llm 能力）→ 结构化文本回注；SHA-256 每会话缓存、类型/尺寸上限、取消传播、不可用时 fail closed；
- 来源：host-image-tool、pi-runtime 的视觉路由逻辑。

**未迁移能力** —— `dsh-lark-members` 未创建；需要时必须重新写 SPEC，并仅授予最小 API 能力。

**`dsh-lark-image` + `dsh-tool-image`** —— 已按 [image SPEC](specs/image.md) 实现并挂载到默认 Worker 组合；图片理解仍由 `dsh-lark-vision` 独立承担。

**`dsh-cdg-bridge`** —— 宿主附件管线中的 CdgBridge 可执行文件封装。

**`dsh-tool-cdg`** —— Worker 模型工具 Consumer；要求运行 Scope，只允许当前会话工作区路径，提供 CDG 检查、读取、单文件/目录加解密、搜索和受控编辑。它不暴露密钥、CLI 路径、原始 MCP、注册命令或宿主任意命令。

### 2.5 能力域（跨域新能力）

**知识（M3）**：`dsh-knowledge`（Definition：摄入事务、查询 ACL、混合检索、引用）+ `dsh-knowledge-postgres`（Provider：pgvector、迁移、版本激活、删除先不可检索）+ `dsh-tool-knowledge`（Consumer：`knowledge_search`，Scope 取自运行信封）。

**cron（M2 起）**：`dsh-lark-cron`（Definition + PG Provider：调度、租约、执行历史、投递 outbox、跨会话管理查询）+ `dsh-tool-cron`（Consumer：自然语言建任务、归一化）。与 `dsh-schedule`（会话内提醒）并存。

**memory（M3）**：`dsh-memory`（Definition：recall/remember、用户键哈希）+ `dsh-memory-mem0`（Provider：mem0 OSS + PG/pgvector）。Worker 默认启用；独立 outbox 未迁移；挂载失败降级无记忆。

**隔离（M2）**：默认 `lightweight` 是禁止任意代码/子进程能力的 capability-restricted host profile，不称为 sandbox；`dsh-sandbox-oci` 仅在显式 OCI profile 下提供 Podman rootless 强隔离。

**邮件（新立）**：`dsh-mail`（Definition）+ `dsh-mail-imap`（nodemailer/imapflow Provider，可选挂载：MAIL_HOST 未配置则整组不激活）+ `dsh-tool-mail`（mail_send / mail_recent / mail_read 工具）——消费 .env 邮件组（SPEC mail.md）。

**技能信任（M2）**：`dsh-skill-trust` —— `skills/trust-manifest.json` 目录摘要 + 版本 + 能力声明预检；失败即拒绝加载。

**web（M1 可选/M3）**：`dsh-web-firecrawl` —— DSH `web` 能力的 Firecrawl provider（search/scrape/map/crawl/research/浏览器/监控，危险操作需确认）；复用 `dsh-tool-web` Consumer。

### 2.6 Bundle 层

**`dsh-lark-base`** —— 平台强制策略 bundle：`cordis.patch.yml` 在 dsh-base 之上插入平台行（lark 域必备行 + 安全不变量行 + 平台提示词政策段）。所有部署组合的第一层。

**`dsh-lark-worker-bundle`** —— worker 组合层（agent 栈 + 执行域 + 能力域行）。
**`dsh-lark-gateway-bundle`** —— 网关组合层（入口 + 渲染 + 审批 + 命令 + 控制面）。

### 2.7 应用与部署

| 位置 | 职责 |
| --- | --- |
| `apps/lark-gateway` | 网关 bin：bundle 层 + 覆盖 cordis.yml；健康端点（WS 心跳为回调健康信号） |
| `apps/lark-worker` | worker bin：bundle 层 + 覆盖 cordis.yml；启动前跑 PG 迁移 |
| `apps/admin` | 管理面 bin（webServer 宿主） |
| `apps/admin-web` | 管理前端（API 契约适配新端点） |
| `infra/postgres` | 便携 PG/pgvector/pgweb 运行器（原 postgres-runtime 平移） |
| `infra/sandbox` | OCI 镜像构建 + 烟雾脚本（原 sandbox-mcp 的镜像部分） |
| `infra/windows` | 服务 supervisor（原 service-runtime + ps1 平移，子进程清单换新 bins） |

## 3. 技能迁移表

| 技能 | 目标 | 说明 |
| --- | --- | --- |
| `skills/rag` | `skills/lark-rag` + knowledge 能力 | 检索/摄入逻辑进能力包；SKILL.md 描述摄入工作流与引用格式 |
| `skills/cron` | `skills/lark-cron` + cron 能力 | 自然语言调度归一化保留在技能；执行/存储进能力 |
| `skills/web` | `skills/lark-web` + web provider | CLI 薄封装进 provider；SKILL.md 描述使用策略 |
| `skills/lark-cli` | 不迁移 | 默认 lightweight 禁止任意 CLI/进程能力；未来仅可作为 OCI 可选能力重新评审 |
| `skills/cdg-bridge` | `dsh-cdg-bridge` + `dsh-tool-cdg` + 纯指引 Skill | 不迁移原脚本/MCP；模型只经当前 Scope 工作区的 `cdg_file` 调用受控二进制 |
| `skills/generate-image` | `dsh-lark-image` + `dsh-tool-image` | 能力进插件；生图/改图（edits multipart + PNG 魔数校验 + 工作区参考图包含校验）语义平移 |
| `skills/todo` | 删除 | DSH tool-todo 内建 |

## 4. 删除清单与理由

| 删除 | 理由 |
| --- | --- |
| `packages/pi-runtime`（全部 79 文件） | Pi SDK 会话、模型运行时、工具编排、子智能体全部由 dsh core 取代（agent-loop、session、llm、tools、subagent、compaction、goal、plan、jobs、schedule） |
| `UiEvent` 联盟 | DSH session 事件流是唯一事件契约（ADR-4） |
| 自研 MCP 适配器（sandbox-mcp 客户端部分） | dsh 内建 `dsh-mcp-client` |
| 自研 TODO（skills/todo + PG todo store + todo-control） | dsh 内建 `dsh-tool-todo`（行为变化已记录） |
| `packages/contracts` 独立包 | 契约随能力就近（DSH 惯例：类型随所有者包），共享部分进 `dsh-lark-contracts` |
| Pi 模型/技能/沙箱/超时全套 `PI_*` 配置 | dsh llm/sandbox/agent-loop 配置取代 |
| lark-claw `.env` 值 | 不读取、不复制、不迁移；dsh 现有本地 `.env` 保持忽略且对代理不透明 |
| `packages/bot-engine`/`bot-config`/`persistence`（架构文档规划中，未实现） | 不复刻：对应 presets / bundle 层 / DSH session 持久化 |

## 5. 复用对照（pi → dsh 收益清单）

| lark-claw 自研（将删除） | dsh 对应能力（挂载复用） |
| --- | --- |
| Pi SDK 会话工厂、会话管理器 | `dsh-agent` + `dsh-session` + `dsh-agent-loop` |
| Pi 子智能体编排器 | `dsh-subagent` + in-process fork/spawn provider + `dsh-tool-subagent(-control/-report)` |
| 自研问卷工具 + 交互存储 | `dsh-user-questions` + `dsh-tool-ask-user` + 本仓库飞书卡片 provider |
| 自研执行预算控制器（部分） | `dsh-tool-call-timeout-policy` + `dsh-lark-run` 的期限逻辑（保留无进展窗口语义） |
| 自研 bash/文件工具策略 | `dsh-tool-bash`/`dsh-tool-pwsh` + `dsh-fs` + `dsh-sandbox-policy` |
| 自研技能加载与信任 | `dsh-skill` + `dsh-skill-filesystem` + 本仓库 `dsh-skill-trust` |
| 自研后台任务 | `dsh-jobs-local` + `dsh-tool-jobs`（会话内提醒 `dsh-schedule` 并存） |
| 自研压缩/上下文策略 | `dsh-compaction-basic` + `dsh-tool-result-pruner` + `dsh-token-meter` |
| 自研提示词组装 | `dsh-system-prompt` + `dsh-persona` + `dsh-agent-instructions` |
| 自研模型/凭证配置 | `dsh-llm-deepseek` + `dsh-llm-pi-ai` + `dsh-credentials-local` + `dsh-settings-file` |
| 自研 MCP 适配 | `dsh-mcp-client` |
| 自研管理 HTTP 服务 | `dsh-host-webserver` + `dsh-lark-admin` |
| 自研模板系统（规划） | `dsh-agent-presets`（preset.yml + agent.cordis.yml + isolate realm） |
| 自研会话/运行持久化 | `dsh-session-persistence-jsonl` + `dsh-session-query-sqlite` |
