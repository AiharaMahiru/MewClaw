# dsh-lark

`D:\AI\dsh` 是 **Lark Claw（`D:\AI\lark-claw`）迁移到 DeepSeek Harness（dsh）后的新仓库**：一个可复用的飞书卡片机器人平台。

底层框架从 Pi Coding Agent 迁移到 dsh：会话、智能体循环、工具、子智能体、审批、沙箱等核心运行时全部由 `@deepseek-ai/dsh-*` 能力承担，本仓库只提供飞书平台专属插件（一切皆插件，Cordis 组合）。

## 状态

**迁移完成，真实飞书验收通过**（M0–M5 全部里程碑）。验收证据：[docs/evidence/m5-feishu-acceptance.md](docs/evidence/m5-feishu-acceptance.md)（多轮聊天/附件知识摄入/图片视觉/cron 创建-执行-投递/控制命令全链路实机确认）。可选后续：部署机演练（docs/release.md 步骤就绪）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/migration-blueprint.md](docs/migration-blueprint.md) | 迁移蓝图：关键架构决策（ADR-1..12）、阶段计划 M0–M5、验收、风险 |
| [docs/threat-model.md](docs/threat-model.md) | 威胁模型：七域攻击面 → 不变量 → 验证测试指引（含 lark-claw ADR 存续判定入口） |
| [docs/component-map.md](docs/component-map.md) | 组件映射：lark-claw 每个组件 → 新仓库包的处置与职责 |
| [docs/remediation-plan.md](docs/remediation-plan.md) | 完善清单：Cordis 合规修复 + 迁移偏移修正（2026-08-16 审计产物，含 P3 决策项） |
| [docs/thinking-framework.md](docs/thinking-framework.md) | 思维模式与工作框架：十条原则、四种工作模式、反模式清单 |
| [docs/spec-standard.md](docs/spec-standard.md) | SPEC 唯一格式、质量门槛、作者自检清单 |
| [docs/specs/](docs/specs/README.md) | 每个包 / 能力缝 / 部署组合的 SPEC（契约，15 份已就绪） |
| [docs/reference/](docs/reference/) | DSH 框架参考（配置目录、README、框架 AGENTS、cc-tui 样例） |

## 代码原则

- **精简、可读**：能删就删，不为"以后可能"写代码；标识符用英文，注释与文档用**完善的中文**。
- **轻量、便携**：依赖按预算管理（dsh 与标准库能胜任就不引新依赖）；运行只需 Node + 便携 PostgreSQL，不强制 Docker。
- **密钥纪律**：`.env` 是本仓库不可读、不可迁移的本地密钥边界；值永不进入源码、git、日志、文档、卡片或事件，也不从其他仓库复制。

## 关键决策速览

- **仓库形态**：独立插件仓库，通过 npm 依赖 `@deepseek-ai/dsh-*`（0.1.0-rc 系列），本地开发用 pnpm workspace + 自有 app bins 从源码启动 cordis 组合。
- **数据面**：会话 / 运行生命周期 / 事件流全部由 DSH session log（JSONL + SQLite 查询）接管；PostgreSQL 仅保留知识库（pgvector）、cron 任务、审批待办与管理面。
- **进程拓扑**：网关（飞书面）与 worker（执行面）保持两个独立进程，各自是一份 cordis.yml 组合；worker 内以 dsh agent-loop 取代 Pi。
- **机器人模板**：映射为 DSH agent presets（每会话 isolate realm 提供隔离）；平台强制策略留在常驻 bundle 层。
- **事件契约**：卡片渲染器直接消费 DSH session 事件流；飞书专属事件（知识引用、产物、审批）通过类型化事件声明合并进入 SessionEventMap。
- **官方 Web 聊天面**：Worker 直接装载 `@deepseek-ai/dsh-web-app` 与 `dsh-lark-web-bundle`，使用官方 frontend、API Proxy、Connection、Session、Workspace、Tool、Plan、Skill、Settings、Model、Deliverables、Workflow 和 Trajectory 能力；`apps/admin-web` 仍是独立管理控制面。

### Worker preset 模式

Windows supervisor 缺省使用 `DSH_LARK_ISOLATION_PROFILE=full`，浏览器显示“飞书全功能模式”，并提供本机执行。
需要无本机执行的轻量工作区时显式设置 `DSH_LARK_ISOLATION_PROFILE=lightweight`；该 profile 只显示“飞书轻量模式”。
需要容器执行时使用 `DSH_LARK_ISOLATION_PROFILE=oci`。只有 full/OCI profile 暴露 system-only 的
`lark-standard`、`liangshen`（展示为“全能优化模式”）以及官方 `standard`、`code`、`minimal`、`cordis` roster，用户目录 preset 不会混入；未知值会拒绝启动。

## 安全不变量（继承自 lark-claw，不因迁移弱化）

- 飞书面进程绝不执行工作区工具；运行隔离在 worker。
- 知识检索 ACL 过滤必须在查询内完成，禁止先取后滤。
- 技能视为供应链输入：版本/摘要/能力声明预检失败即拒绝加载。
- 卡片回调永远只是服务端状态引用，不是授权证据。
