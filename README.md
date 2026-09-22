# MewClaw Desktop 开发

MewClaw 基于 DeepSeek Harness（DSH）与 Cordis，为 Web、Windows Desktop 和 TUI 提供共享账号与模型能力。Agent、会话、工具、审批和持久化复用官方插件；自有功能通过 Provider、公开 slots 与配置组合接入，官方 DSH 包保持原样。

本分支 `desktop-dev` 用于 **Desktop 本机工作区、Web 组件一致性及兼容性验证**，集成共享账号与 TUI 接入。Web 和共享服务以 `master` 为基线。Desktop 的完整客户端组合与发行配置见 [`desktop`](https://github.com/AiharaMahiru/MewClaw/tree/desktop)，TUI 实现见 [`AiharaMahiru/dsh-TUI`](https://github.com/AiharaMahiru/dsh-TUI)。

## 当前能力

- Web 使用云端工作区、会话与工具。
- Windows Desktop 支持云端／本地切换；本地目录从原有工作区选择器进入。Desktop 分支复用 Web 的组件、自有插件、四种模式与思考强度滑条。
- TUI 支持 `dsh-tui "D:\项目\我的工程"` 或 `/workspace open <目录>`。用 `/connect` 登录，在 `/model` 选择 MewClaw 云端账号后，普通聊天可调用本机工具。
- 本机模式的 Agent、文件和会话日志在电脑运行，云端提供认证、模型目录及推理；不要求绑定云端工作区，不复制供应商 API Key。模型推理需要网络，工作目录本身不是沙箱。

使用步骤、两仓库的源码范围与验证边界见 [本机工作区说明](docs/client-local-workspaces.md)；TUI 共享客户端见 [TUI 接入说明](docs/dsh-tui.md)。

## 版本与验证

2026-09-23 的 Web/共享依赖为 DSH `0.1.6-alpha.2`、Cordis `4.0.2`。Desktop 分支的独立 Windows 候选使用相同 DSH/Cordis、Electron `44.0.0`；TUI fork 的已验证宿主为 DSH `0.1.5-rc.1`，具体版本以各自锁文件为准。

已完成本机文件读写、会话恢复、账号模型与界面对照检查。Windows EXE 的 Wine 功能测试与 Windows 实机验收分别记录；安装交互、UNC/网络盘、ConPTY 和原生窗口材质仍待实机验收。候选包未签名，Git 推送不代表正式发布或生产切换。

## 开发

需要 Node.js 24+、pnpm `10.30.3`。首次克隆使用 `--recurse-submodules`；GitHub 源码 ZIP 不包含子模块。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm verify:official-integrity
pnpm verify:dsh-brand
```

日常按改动运行针对性检查，全套检查用于里程碑或 CI 诊断。服务入口包括 `pnpm dev:worker`、`pnpm dev:gateway`、`pnpm dev:auth` 和 `pnpm dev:admin`。数据库、凭证引用和 Cordis 组合需要单独配置；安装依赖不等于完成部署。见 [发布与回滚](docs/release.md)。

## 分支协作

| 分支 / 仓库 | 职责 |
| --- | --- |
| `master` | Web、共享插件与云端服务 |
| `desktop` | Windows 客户端集成、候选与发行配置 |
| `desktop-dev` | Desktop 集成开发及兼容性验证 |
| `feat/dsh-tui-remote-workspace` | 本机工作区及跨客户端接入的集成分支 |
| `AiharaMahiru/dsh-TUI` 的 `main` / 同名功能分支 | TUI 本身与官方 adapter |

共享修复先进入 `master`，再按 `master → desktop-dev/desktop` 正常合并；保留共同历史，不反复 squash/cherry-pick，也不把整条桌面开发分支反向合并进 Web。各端独立发布，不随 Git 推送切换生产。

## 项目结构

```text
apps/       Worker、Gateway、Auth、Admin、Desktop 等入口
packages/   认证、平台接入、模型、知识库、记忆、工具与 UI 插件
infra/      Linux / Windows 部署、PostgreSQL 与沙箱设施
scripts/    构建、验证与发布脚本
tests/      跨包测试
docs/       架构、SPEC、开发及验收说明
```

## 文档与开发规则

- [迁移蓝图](docs/migration-blueprint.md)、[组件映射](docs/component-map.md)、[SPEC 索引](docs/specs/README.md)。
- [威胁模型](docs/threat-model.md)、[SPEC 标准](docs/spec-standard.md)、[DSH 参考](docs/reference/)。
- [Desktop 开发文档](https://github.com/AiharaMahiru/MewClaw/blob/desktop/apps/desktop/README.md)、[本机工作区说明](docs/client-local-workspaces.md)。

修改前读 [AGENTS.md](AGENTS.md)，先更新 SPEC，再使用已有插件接缝实施。飞书 Gateway 不执行工作区工具；知识库 ACL 在查询内过滤；会话日志是模型可见事实的持久化来源。`.env` 和凭证不得进入 Git、日志或文档。保持无关改动、用户会话与生产配置不变。
