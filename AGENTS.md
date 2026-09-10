# AGENTS.md — dsh-lark 工作规则

本仓库是 Lark Claw 迁移到 DeepSeek Harness（dsh）后的飞书卡片机器人平台：**独立插件仓库**，通过 npm 依赖 `@deepseek-ai/dsh-*`，一切皆插件（Cordis）。蓝图见 [docs/migration-blueprint.md](docs/migration-blueprint.md)。

框架侧完整惯例（vendored Cordis 语义、事件信封机制、类型规则原文）见 [docs/reference/dsh-AGENTS.md](docs/reference/dsh-AGENTS.md)；冲突时本文件优先，其次是蓝图与 SPEC。

## 文档导航

完整文档地图见 [README.md](README.md)。速查：蓝图 [docs/migration-blueprint.md](docs/migration-blueprint.md) · 组件映射 [docs/component-map.md](docs/component-map.md) · 思维模式 [docs/thinking-framework.md](docs/thinking-framework.md) · SPEC 标准 [docs/spec-standard.md](docs/spec-standard.md) · SPEC 索引 [docs/specs/](docs/specs/README.md)。

## 核心规则

1. **SPEC 先行**：没有 SPEC 的包不得开始实施。SPEC 状态机与自检清单见 spec-standard.md；蓝图 / SPEC 冲突先改文档再改代码。
2. **一切皆插件**：新行为落在插件或既有扩展点上；每个能力按 Definition / Provider / Consumer 三角色组织（能力缝完整，不做单角色）。动 dsh 框架源码属于范围外。
3. **复用先于自研**：动手前查 dsh 已提供的能力（`docs/reference/cfg_zh.md` 插件目录、已安装包清单）。自研必须写明 dsh 为什么不能胜任。
4. **注册即效果**：所有贡献经 `ctx.effect()` / `ctx.on()`；注册表的 `register()` 返回 disposer。瀑布监听器必须调 `next()`。
5. **类型化事件用声明合并**：飞书专属 session 事件在 `dsh-lark-contracts` 合并进 `SessionEventMap`，事件 JSDoc 带 `@mode` 与 payload `@param`；scoped 键缺省标 `@dshScopeScan unsupported`。
6. **模型可见 ⟺ 已落盘**：任何进入模型请求的内容必须能从 session log 重建；新增模型可见输入必须同一变更内新增承载事件。
7. **类型与校验**：`strict` 全开；跨边界 ID 品牌化；判别联合 switch 穷尽；运行时校验只在解析/队列/JSON/持久化/进程/wire 边界；同进程静态保证不加防御代码。
8. **配置纪律**：部署可变项是 cordis.yml 可写的校验后 Config 字段；密钥只以凭证引用出现；无硬编码 tunable；配置缺失 fail loud。
9. **ESM 与结构**：全仓库 ESM；跨包导入用包名；包位于 `packages/<域>/<名>`，npm 名 `dsh-lark-*` 或能力名（knowledge/memory/sandbox 前缀）。
10. **测试门禁**：每步跑针对性检查（包测试 + typecheck + lint），不做全套；全套留给里程碑收尾与 CI 诊断；任何模型可见 / 用户可见输出变化必须加可无密钥重放的快照。证据归档 `docs/evidence/`。
11. **代码风格**：精简、可读优先；完善的中文注释（标识符与类型名用英文，注释与文档用中文）；不写"以后可能用"的代码；SPEC 的接口注释是实现的注释基准。
12. **轻量便携**：依赖按预算管理——新增依赖必须证明 dsh 与标准库不能胜任；重量级依赖默认拒绝或必须提供可关闭的降级路径（mem0 当前默认启用，可显式 `enabled: false` 降级）；运行只需 Node + 便携 PostgreSQL，不强制 Docker。
13. **文件尺寸是弹性门禁**：300 行是优先评审和拆分阈值，300–600 行可在单一职责、可读性和测试充分时保留，600 行是默认上限；生成文件、快照等按其来源单独评估，不为凑行数制造无意义拆分。

## 硬边界（继承 lark-claw，不因迁移弱化）

- 飞书面（网关进程）**绝不执行**工作区工具；执行只发生在 worker 进程。
- 知识检索的 ACL 过滤必须在查询内完成；先取后滤禁止。
- 技能是供应链输入：版本、摘要、能力声明预检失败即拒绝加载。
- 卡片回调载荷只是服务端状态引用，永不是授权证据。
- 所有有状态操作携带完整 Scope（tenant/bot/deployment/user/conversation）。
- `.env` 默认是不可读、不可迁移的本地密钥边界：不得从 lark-claw 读取、打印、复制或迁移值；本仓库已有 `.env` 保持 git-ignored 且对代理不透明。源码、日志、文档、卡片和事件只允许出现经过清理的变量名或凭证引用。唯一例外是用户已明确授权的 `.codex-tasks/20260824-dsh-replace-dooragent/` 生产迁移：只允许不回显内容的原文件字节传输、SHA-256 一致性校验和最小权限设置，仍禁止进入 Git、日志、证据或消息输出。
- lark-claw 的 `examples/`（上游飞书样例）是参考材料、不是产品架构；本仓库未引入，架构判断不得以其为据。
- 不宣称未经验证的隔离：目录分离 ≠ 沙箱；RAG 私有性以跨 scope 拒绝测试为准。

## 命名与发布

- 工作区包名 `dsh-lark-*`（生态惯例，参考 dsh-cc-tui）；能力缝包可用 `dsh-knowledge-*` / `dsh-memory-*` / `dsh-sandbox-oci`。
- 当前不占用 `@deepseek-ai` 发布作用域；私有仓库采用 workspace `file:` 依赖 + git/release archive 分发，官方依赖锁定精确版本。
- 依赖的 dsh 包锁定精确版本（M0 固化 `pnpm-lock.yaml`）。
- **品牌插件是升级硬门禁**：官方 UI 与 Web 包必须保持原样；MewClaw 品牌仅通过 `dsh-lark-atw-brand` 占据公开 slots，并通过 WebServer transform/route 提供元数据与资源。`pnpm install`、`pnpm verify:dsh-brand` 与官方完整性门禁未通过前不得接受升级。

## 运行态验收经验

- `service:status` 可能来自 supervisor 的旧状态快照；恢复或重启后必须交叉验证 `pnpm postgres:status`、`pg_isready`、实际监听端口、当前 PID 和 HTTP 健康响应，不能只依据快照中的 `healthy`。
- lightweight Web profile 禁用的行可能保留对应 404 路由作为 fail-closed 边界；页面不应继续加载旧缓存或用户侧插件客户端，真实浏览器控制台仍需单独验收。

## 行为变化记录

迁移引入的行为变化必须显式记录（SPEC §9）：例如自研 PG TODO 被 dsh `tool-todo`（会话本地）取代、`UiEvent` 联盟被 session 事件流取代。

## 身份

面向用户的沟通中，自称 **MewClaw**。

## 已验证经验

### Windows OpenSSH 在 VPS banner 阶段触发 WSASendCB

- **触发信号**：目标 SSH 端口可建立 TCP，但 Windows 系统 `ssh.exe` 在发送 client identification 后报 `WSASendCB - ERROR: broken assumption`，并以 `banner exchange ... eother` 退出。
- **根因 / 约束**：这是本机 OpenSSH 客户端路径的异常证据，不能据此判定远端 sshd、密钥或网络不可用。
- **正确做法**：先用 `Test-NetConnection` 确认端口，再使用 `C:\Program Files\Git\usr\bin\ssh.exe` 和同一 SSH config/identity 执行受控命令；不要循环重试系统客户端。
- **验证方式**：替代客户端必须完成密钥认证并成功运行最小只读命令，随后再恢复正式 preflight。
- **适用范围**：Windows 主机到 `mewclaw-vps` 的迁移、部署、验证和切流操作。
