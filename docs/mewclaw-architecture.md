# MewClaw 统一架构与演进约定

2026-09-23 用户确定的产品原则：Web、TUI、Windows Desktop、Feishu（飞书）是同一个 MewClaw 的四个接入端。Web 是产品、交互与共享策略基线；DSH 官方上游是运行时与能力契约主线。本文件记录已确定原则、当前实现和待实施优化，不改变现有运行协议、数据格式或部署。

## 1. 能力归属

| 层次 | 权威来源与职责 | 各端接入方式 |
| --- | --- | --- |
| DSH 运行时 | 官方 Agent、Session、Workspace、LLM、工具、审批、持久化与事件契约 | 使用已安装版本的公开服务和插件接缝 |
| MewClaw 共享能力 | `master` 中的身份、资源授权、模型与额度、技能策略、模式目录及自有插件 | Provider / Consumer / Bundle 组合；共享策略以 Web 基线演进 |
| 接入与呈现 | Web UI、Windows 外壳、TUI 终端、飞书消息与卡片 | 消费共享能力；只承担各端输入、展示和传输差异 |
| 执行与存储位置 | 云端 Worker 或本机 Harness | 通过对应 FileSystem、Shell、持久化等 Provider 执行；不改变能力所有权 |

“接入端”与“执行位置”是不同维度。Windows 本地模式仍使用 Web 同源组件、自有插件、模式与思考强度滑条，打开本机目录仍在原有工作区选择器中。TUI 与飞书按终端/卡片形式表达同一能力语义，不复制浏览器组件；平台尚未支持的能力须明确记录差距。

四端一体不意味着所有会话自动同步、共享同一目录或共用同一个 Cordis 根。跨端发现、认领和切换会话必须使用经过授权的目录与资源关系；模型请求所需的提示词和工具结果仍会到达推理服务。本机目录不是操作系统沙箱。

## 2. DSH 与 Cordis 实施规则

- 新能力先查询 DSH 现有 Definition / Provider / Consumer；复用不适用时，SPEC 必须说明缺口。只在确有独立演进需求时拆包，不增加平行的 Agent、会话或工具循环。
- 贡献通过 `ctx.effect()`、`ctx.on()` 或返回 disposer 的注册入口建立，卸载释放订阅与资源；瀑布监听器调用 `next()`。通过受支持的配置与 Provider 替换接入，不覆写官方实例方法、不修改官方包。
- 会话持久化事件是模型输入、工具结果与呈现的事实来源；新增模型可见内容同步定义事件和无密钥组合回放。TUI 转录和飞书卡片只做投影。
- 配置在所属插件解析并校验，凭证只用引用。平台差异通过能力与组合表达，不在 UI 中硬编码业务授权，不为四端统一放宽 Scope、ACL、审批或沙箱要求。
- DSH 升级由 Web 主线先核对上游变更，各端同步评估并验证 adapter、插件组合与持久化兼容性。可以保留明确记录的兼容版本；锁文件、真实平台结果和产品版本不能混为一谈。

详细规则见 [AGENTS.md](../AGENTS.md)、[DSH 参考规范](reference/dsh-AGENTS.md) 与 [SPEC 标准](spec-standard.md)。

## 3. 当前实现与差距

| 接入端 | 已有共享路径 | 当前边界 |
| --- | --- | --- |
| Web | 官方 Web 组件、MewClaw UI/认证插件、Auth Edge 与云端执行面 | 产品和共享策略基线；资源仍按用户授权 |
| Windows | Desktop 分支从 Web 组合生成 UI、品牌和模式策略；云端/本地分别连接对应 Harness | 安装外壳与原生依赖单独交付；平台实测边界见[本机工作区说明](client-local-workspaces.md) |
| TUI | fork 的 adapter 消费官方 Agent/Channel；云端账号提供模型，本机 Harness 执行本地会话 | 远程控制菜单与本地聊天不同；共享传输源码仍有物理副本 |
| Feishu | `gateway → run-client → Worker → 官方 Agent → SessionEvent → 卡片`；`session-directory` 提供授权会话目录 | 每个 bot 独立 Cordis 根；共享会话依照现有归属、claim/use 或可信内部认领流程建立 |

已核对的代码事实：

- [`packages/lark/tui-remote/src`](../packages/lark/tui-remote/src) 与 TUI fork 的 `src/dsh-adapter/remote` 目前有 11 个同名共享文件，逐字节一致。TUI 实际从 `./remote/index.js` 导入，并没有通过 `dsh-lark-tui-remote` 包解析运行；目前未发现跨仓库同步门禁。TUI 自有 `account-model.ts`、`account-inference.ts`、`local-files.ts` 需与传输层分开管理。详见 [TUI 接入](dsh-tui.md)。
- Desktop 已通过 Web 同源准备减少 UI 副本；准备逻辑见[桌面分支脚本](https://github.com/AiharaMahiru/MewClaw/blob/desktop/scripts/prepare-desktop-web.mjs)。这属于构建时组合复用，不代表四端运行在同一进程。
- [`bot-runtime.ts`](../packages/lark/gateway/src/bot-runtime.ts) 为每个飞书 App 建立独立 Cordis 根；[`executor.ts`](../packages/lark/run/src/executor.ts) 按目录解析结果使用共享会话或 Scope 派生工作区；[`SessionUseRequest`](../packages/lark/contracts/src/run.ts) 明确 sessionId 只用于定位，Worker 必须重新验证归属。
- Web/Desktop 与 TUI 当前验证的 DSH 版本仍不同，见 [README 版本说明](../README.md#版本与验证)。统一产品不能作为跳过 TUI 上游兼容门禁的理由。

## 4. 架构优化顺序

以下是下一阶段方案，尚未作为运行态重构实施。每项落地前更新对应 SPEC，并保留原有拒绝用例与可重放事实。

1. **统一共享传输的来源与交付。** 以 `master` 的共享客户端为源，优先让 TUI 消费可复现的包产物；如果独立构建仍需源码副本，则记录来源提交与逐文件摘要，并加入双仓库漂移检查。只处理共享文件，保留 TUI 平台扩展。验收须覆盖干净构建、分发包入口、认证、CSRF、流重连与本地文件回放，不能只对比文本。
2. **统一能力目录和策略的来源。** 从现有 Web/共享服务的模型、模式、技能与授权能力中确定各项唯一维护位置，逐项让 Windows、TUI、飞书消费。保留官方注册表和 Provider，不先创建“万能核心包”。验收包括目录、默认选择、实际挂载、工具效果及卸载清理；不能仅凭菜单名称一致宣称功能一致。
3. **统一升级和验收记录。** 每次共享变更记录四端影响、DSH 版本、源码提交、交付产物及通过/未覆盖的能力。Web 与 Windows 复核同源 UI；TUI 验证终端交互和事件投影；飞书验证消息/卡片、回调归属、重复投递及断线恢复。真实平台、真实账号模型、无密钥回放分别记证据。

跨端身份和会话目录在现有授权关系上增量演进；是否自动发现、同步或迁移会话需单独定义所有权和冲突策略，本轮不引入这些行为。

## 5. 仓库与分支协作

`master` 承担以 Web 为基线的四端共享产品、插件与服务；Desktop 分支承载外壳、适配和发行组合；TUI fork 保留终端 adapter 与平台实现。飞书按接入与执行插件继续消费同一 DSH 能力体系。

共享修复先进入 `master`，再同步到各端。已有桌面历史不整条反向合入 Web；需要提取的共享职责逐项立 SPEC、迁移和验收。仓库拆分、平台安装包和不同发布节奏服务于交付，不能成为复制业务策略或遗漏另一端升级影响的理由。

每次变更在说明中回答：共享能力的维护位置、四端各自影响、执行与持久化所在宿主、官方扩展点、已验证及未覆盖边界。没有行为变化的文档调整只做文档检查；运行态修改按相应 SPEC 验证，发布和生产切换遵守既有授权流程。
