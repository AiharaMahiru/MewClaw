# MewClaw

MewClaw 是基于 **DeepSeek Harness（DSH）与 Cordis** 的智能体平台，提供 Web 聊天、飞书自建应用机器人、账户与用量管理，以及可组合的工具和技能。仓库沿用 `dsh-lark-*` 包名。

会话、智能体循环、工具、子智能体、审批和沙箱等核心运行时复用 `@deepseek-ai/dsh-*`。品牌、认证、平台集成及部署策略通过自有插件、公开扩展点和配置组合实现；不修改官方 DSH 源码或附属官方包。

## 状态

DSH 核心及官方插件锁定 `0.1.5-rc.1`。lightweight 不再裁剪执行能力，保留模式 ID 并复用官方 standard；Scope、目录授权、审批及 OCI 边界不变。2026-09-10 已切换生产 `R3-dsh-015-rc1-presetfix-20260910`，包含模式人设与PTC兼容修复，基础健康检查通过，等待用户实际功能测试；尚未提交或推送。见 [升级说明](docs/dsh-0.1.5-upgrade.md)。

截至 **2026-09-10，生产基线为 R3**。本机生产入口 `/opt/dsh/current` 指向 `releases/R3`；Git 分支后续提交不等于生产已发布。

- R3 已发布远程设置修复和四模式整合，见 [R3 设计说明](docs/specs/web-remote-settings-r3.md) 与 [生产验收记录](docs/evidence/r3-production-20260910.md)。
- 早期 M0–M5 飞书迁移验收见 [历史证据](docs/evidence/m5-feishu-acceptance.md)，不代表后续新增功能已通过端到端验收。
- **飞书统一账号管理已上线**：账户中心与「飞书连接」分离；自建应用支持 App ID/Secret 加密保存、官方凭证校验、连接/断开与状态刷新。每账号独立机器人实例和会话归属。2026-09-10 切换至 `R3-account-bots-only-20260910-2`，移除部署级连接及旧App保留限制，旧凭据不自动导入。发布验收时账号配置为0、飞书连接为0，用户需在页面保存并启用应用；历史身份和会话保留。源码回归、候选空清单运行、六服务入口及公网检查通过；真实个人飞书收发仍需应用发布/权限验收。详见 [账号机器人规范](docs/specs/feishu-bots.md) 与 [发布证据](docs/evidence/20260910-account-only-bots.md)。
- **生产模型目录**：OpenAI/GPT保持不变；DeepSeek只公开 `DeepSeek V4.1 Flash`（逻辑ID `deepseek-v4.1-flash`），由自有路由插件序列化为供应商wire ID。Gemini Web2API已从模型Provider目录移除，Gemini搜索MCP继续作为独立工具保留。凭据仅由受管环境文件提供，不进入仓库。

## 项目结构

```text
apps/       # Worker、飞书 Gateway、Auth、Admin、浏览器与预览服务入口
packages/   # 自有插件：平台接入、认证、模型、知识库、记忆、工具等
infra/      # Linux / Windows 部署、PostgreSQL 与沙箱设施
presets/    # 智能体预设
skills/     # 技能资源
scripts/    # 构建、验证与发布脚本
tests/      # 跨包测试
docs/       # 架构、SPEC、发布说明与验收证据
```

## 开发与验证

需要 Node.js 24+、pnpm 10.30.3；生产构建使用部署指定的固定 Node 版本。DSH 核心依赖当前锁定为 `0.1.5-rc.1`，以锁文件为准。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:official-integrity
pnpm verify:dsh-brand
```

开发入口包括 `pnpm dev:worker`、`pnpm dev:gateway`、`pnpm dev:auth` 和 `pnpm dev:admin`。启动前须配置对应服务的数据库、凭证引用和插件组合；安装依赖不等于完成部署。完整步骤和生产回滚要求见 [发布文档](docs/release.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/migration-blueprint.md](docs/migration-blueprint.md) | 迁移蓝图：关键架构决策（ADR-1..12）、阶段计划 M0–M5、验收、风险 |
| [docs/threat-model.md](docs/threat-model.md) | 威胁模型：七域攻击面 → 不变量 → 验证测试指引（含 lark-claw ADR 存续判定入口） |
| [docs/component-map.md](docs/component-map.md) | 组件映射：lark-claw 每个组件 → 新仓库包的处置与职责 |
| [docs/remediation-plan.md](docs/remediation-plan.md) | 完善清单：Cordis 合规修复 + 迁移偏移修正（2026-08-16 审计产物，含 P3 决策项） |
| [docs/thinking-framework.md](docs/thinking-framework.md) | 思维模式与工作框架：十条原则、四种工作模式、反模式清单 |
| [docs/spec-standard.md](docs/spec-standard.md) | SPEC 唯一格式、质量门槛、作者自检清单 |
| [docs/specs/](docs/specs/README.md) | 每个包 / 能力缝 / 部署组合的 SPEC 契约 |
| [docs/release.md](docs/release.md) | 发布门禁、生产目录、部署与回滚 |
| [docs/reference/](docs/reference/) | DSH 框架参考（配置目录、README、框架 AGENTS、cc-tui 样例） |

## 代码原则

- **精简、可读**：能删就删，不为"以后可能"写代码；标识符用英文，注释与文档用**完善的中文**。
- **轻量、便携**：依赖按预算管理（dsh 与标准库能胜任就不引新依赖）；运行只需 Node + 便携 PostgreSQL，不强制 Docker。
- **密钥纪律**：`.env` 是本仓库不可读、不可迁移的本地密钥边界；值永不进入源码、git、日志、文档、卡片或事件，也不从其他仓库复制。

## 关键决策速览

- **仓库形态**：独立插件仓库，通过 npm 依赖 `@deepseek-ai/dsh-*`（0.1.0-rc 系列），本地开发用 pnpm workspace + 自有 app bins 从源码启动 cordis 组合。
- **数据面**：会话 / 运行生命周期 / 事件流全部由 DSH session log（JSONL + SQLite 查询）接管；PostgreSQL 仅保留知识库（pgvector）、cron 任务、审批待办与管理面。
- **进程拓扑**：飞书 Gateway 与 Worker 执行面分离，Auth、Admin、浏览器和预览服务按部署组合独立运行；各入口通过 Cordis 配置装载插件。
- **机器人模板**：映射为 DSH agent presets（每会话 isolate realm 提供隔离）；平台强制策略留在常驻 bundle 层。
- **事件契约**：卡片渲染器直接消费 DSH session 事件流；飞书专属事件（知识引用、产物、审批）通过类型化事件声明合并进入 SessionEventMap。
- **官方 Web 聊天面**：Worker 直接装载 `@deepseek-ai/dsh-web-app` 与 `dsh-lark-web-bundle`，使用官方 frontend、API Proxy、Connection、Session、Workspace、Tool、Plan、Skill、Settings、Model、Deliverables、Workflow 和 Trajectory 能力；`apps/admin-web` 仍是独立管理控制面。

### Worker preset 模式

R3 新建模式目录收敛为 `lightweight`、`standard`、`liangshen`、`cordis` 四个稳定 ID。旧 `lark-standard`、`ptc`、`minimal` 保留解析与历史会话恢复能力，不删除既有会话数据。

模式目录与执行隔离是不同维度：`DSH_LARK_ISOLATION_PROFILE` 的 `full`、`lightweight`、`oci` 决定对应部署的执行能力，具体工具以实际插件配置为准；不能只凭模式名称认定已启用容器隔离。

## 安全不变量（继承自 lark-claw，不因迁移弱化）

- 飞书面进程绝不执行工作区工具；运行隔离在 worker。
- 知识检索 ACL 过滤必须在查询内完成，禁止先取后滤。
- 技能视为供应链输入：版本/摘要/能力声明预检失败即拒绝加载。
- 卡片回调永远只是服务端状态引用，不是授权证据。
