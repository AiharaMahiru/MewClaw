# MewClaw Desktop

这是 MewClaw 的 **`desktop` 桌面开发与发行分支**，以 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 为 Electron 底座，基于 **DeepSeek Harness（DSH）与 Cordis**。目标是使用同一账号与 Web 端共享云端会话，并额外提供用户授权的电脑本地工作区。仓库沿用 `dsh-lark-*` 包名。

会话、智能体循环、工具、子智能体、审批和沙箱等核心运行时复用 `@deepseek-ai/dsh-*`。品牌、认证、平台集成及部署策略通过自有插件、公开扩展点和配置组合实现；不修改官方 DSH 源码或附属官方包。

## 当前状态

截至 **2026-09-12，desktop-dev 已合并最新 `origin/desktop@3d88e2d`**。Web 与独立 Windows 候选统一使用 DSH `0.1.5-rc.2`；当前唯一候选和 Release 产物已在 Windows x64 目录模式完成验证。生产和真实模型验收仍需单独执行。

共享 Web 主题插件已同步：`dsh-lark-liquid-glass` 提供双色 SVG 背景、个人开关和中性玻璃材质；标题及顶部标签保持透明无框。桌面端需在自己的 Electron 候选中重新验证，不将 Web 生产配置或密钥复制到本机。

- 已验证：独立桌面底座构建、Release Electron 启动、目录模式会话编辑，以及同一进程内 cloud↔local 双向切换；未以此代替真实账号或生产模型验收。
- 已实现并验证：原生目录授权、文件工具、独立 Shell 授权/撤销、长命令心跳、二进制文件双向同步、冲突保留与可恢复删除；Auth Edge 到本机的离线 HTTP 全链路已通过。
- 云端共享包、Web 和独立桌面候选统一锁定 DSH `0.1.5-rc.2`。官方包不修改，桌面客户端和云端的共享 Consumer 分别验证兼容性。
- 云端通过 [可选 overlay](config/desktop-workspace.patch.yml) 启用桌面桥接，默认保持关闭。Git 合并和推送不会自动切换生产。
- 本地 Harness 当前只开放用户原生授权的目录文件能力；云端旧 workspace/Shell/同步桥接仍由独立 overlay 控制，不会因切换本地模式而静默启用。目录授权不是操作系统沙箱。

## 分支协作

- [`master`](https://github.com/AiharaMahiru/MewClaw/tree/master)：Web、共享插件和云端服务。
- `desktop`：桌面启动器、自有桌面插件、打包配置与桌面发行文档。
- Web 更新通过 **`master → desktop` PR** 同步，采用普通 Merge 保留共同历史，不对长期同步 PR 反复 Squash 或 cherry-pick。
- 共享修复优先在基于 `master` 的短期分支提交，再同步至桌面；不把整个桌面分支反向合并进 Web。
- 两端独立发布，桌面版本标签使用 `desktop-vX.Y.Z`；同步后仍须通过桌面兼容与验收门禁。

## 桌面架构与开发

云端是会话和模型运行的唯一权威；桌面通过自有 WebServer Provider 接入同一云端，不复制 SQLite 或 JSONL。电脑侧消费官方 FileSystem/Shell，同步通过共享 Node Provider 实现；模型不能自行开启本机授权。

官方 DSH 包保持原样。社区桌面底座有明确记录的最小消费方兼容及 Provider 选择变更，**不宣称社区桌面源码零改动**；准备脚本固定上游提交并生成 `UPSTREAM.json`，不继承社区的官方包补丁。

需要 Node.js 24。桌面使用独立 npm 候选 workspace，不向服务器 pnpm 依赖树引入 Electron。

```sh
git submodule update --init --recursive
# 在本仓库 desktop 分支根目录执行；目标候选目录必须尚不存在。
node scripts/prepare-desktop-candidate.mjs /absolute/MewClaw/upstream/dsh-desktop D:/AI/dsh/MewClaw-desktop-candidate
cd D:/AI/dsh/MewClaw-desktop-candidate
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node /absolute/MewClaw/apps/desktop/verify-workspace.mjs D:/AI/dsh/MewClaw-desktop-candidate
```

以上仅用于开发候选构建与测试，不生成安装包。安装生命周期默认关闭，Electron 下载和目标平台原生依赖须另行审核处理；Linux 构建通过不等于 Windows 实机通过。凭证、运行数据和候选目录不得提交 Git。

上游以 Git 子模块保存在 `upstream/dsh-desktop`，固定到已评审提交，不跟随上游 HEAD 自动升级。首次克隆可用 `git clone -b desktop --recurse-submodules https://github.com/AiharaMahiru/MewClaw.git`；已有检出执行上面的初始化命令。请将命令中的绝对路径替换为本机路径；Windows 使用绝对盘符路径。GitHub 的源码 ZIP 不包含子模块内容。

详见 [桌面开发说明](apps/desktop/README.md)、[桌面 APP SPEC](docs/specs/desktop-app.md) 与 [本地工作区 SPEC](docs/specs/desktop-workspace.md)。

## 项目结构

```text
apps/desktop/ # 桌面启动器和自有云端接入插件
apps/       # 共享服务：Worker、飞书 Gateway、Auth、Admin 等
packages/   # 自有插件：平台接入、认证、模型、知识库、记忆、工具等
infra/      # Linux / Windows 部署、PostgreSQL 与沙箱设施
presets/    # 智能体预设
skills/     # 技能资源
scripts/    # 构建、验证与发布脚本
tests/      # 跨包测试
docs/       # 架构、SPEC、发布说明与验收证据
```

## 共享服务开发与验证

需要 Node.js 24+、pnpm 10.30.3；生产构建使用部署指定的固定 Node 版本。Web 与桌面候选的 DSH 核心依赖当前统一锁定为 `0.1.5-rc.2`，以各自锁文件为准。

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

- **仓库形态**：独立插件仓库，通过 npm 依赖 `@deepseek-ai/dsh-*`（当前核心基线 `0.1.5-rc.2`），共享服务使用 pnpm workspace + 自有 app bins 从源码启动 Cordis 组合；桌面使用独立候选 workspace。
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
