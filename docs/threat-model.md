# 威胁模型（threat model）

自 lark-claw `docs/threat-model.md` 重写（完善清单 R-12）：威胁面沿袭，架构基线换成 dsh——网关/worker/admin 三进程拓扑、DSH session log 唯一事件契约、能力缝（Definition/Provider/Consumer）、bundle 组合校验。安全不变量以 [AGENTS.md](../AGENTS.md) 硬边界为基线；本文每域给出**攻击面 → 不变量（实现锚点）→ 验证测试指引**。

## 资产

- 飞书应用凭证（APP_ID/SECRET）、worker/admin 共享令牌、模型与嵌入供应商密钥；
- 知识库文档（user_private / bot_shared）与嵌入向量；
- 用户工作区、DSH 会话日志（session log）、cron 任务与执行历史；
- bot 模板（presets：persona/技能清单/修订号）与技能信任清单；
- 部署策略（bundle 行集、隔离 profile、平台提示词政策）。

## 信任边界

```text
飞书平台 ⇄ [lark-ws 入口] → 网关进程（无任何工具/agent 行）
                │ loopback HTTP + WORKER_TOKEN
                ▼
           worker 进程（dsh agent 栈 + 能力缝；lightweight 或 OCI profile）
                │ 凭证引用解析           │ 查询内 ACL
                ▼                        ▼
           .env（本地密钥边界）      PostgreSQL（知识/cron/审批）
网关卡片回调 ⇄ （载荷=服务端状态引用，非授权证据）
浏览器 ⇄ admin 进程（loopback 默认；Bearer 恒定时间比较；无 dsh-base）
```

七条边界（沿袭 lark-claw 编号）：① 飞书事件入口→网关；② 网关→运行提交（run-client→worker HTTP）；③ worker→agent 会话与工具；④ agent→技能与工具注册表；⑤ worker→工作区/凭证/网络/知识检索；⑥ 知识摄入→索引内容；⑦ 卡片回调载荷→服务端授权状态。

## 威胁域

### 1. 跨用户/跨租户访问与知识 ACL

**攻击面**：复用的会话/路径/缓存键/检索查询/凭据泄露其他 Scope 的数据；RAG 检索"先取后滤"把受限分块带进排序或模型上下文。

**不变量**：

- 每个有状态操作携带完整五元 Scope（tenant/bot/deployment/user/conversation，品牌化 ID；wire 边界过 `parseScope`）；
- 知识检索的 ACL 过滤**在查询内完成**——词法与向量分支共享同一检索谓词（`dsh-knowledge-postgres`；lark-claw ADR-0003 存续）；
- 上传物化校验 scope 归属前缀 + SHA-256 摘要；发送方文件名/扩展名/上游 MIME 不作为内容或路径可信证据（内容驱动检测，`dsh-lark-uploads`）；
- 网关授权判定（allowlist）**先于**去重与任何运行提交（防放大）；去重按 platform eventId 窗口幂等。

**验证**：`knowledge-postgres/src/store.test.ts`（跨用户私有隔离 / 跨 bot 跨租户拒绝 / 词法向量同 ACL）；`tests/knowledge-e2e.test.ts`（摄入→检索→跨用户拒绝→归档不可检索）；`uploads/src/materialize.test.ts`（前缀/摘要/源缺失/CDG 无桥拒绝）；`gateway/src/index.test.ts`（陌生用户拒绝卡不提交运行、陌生群拒绝、eventId 幂等）。**RAG 私有性以跨 scope 拒绝测试为准，不宣称未经验证的隔离。**

### 2. 执行隔离与沙箱逃逸

**攻击面**：提示词内容或技能在预期工作区之外执行命令、耗尽宿主资源、触达未授权网络；网关进程被诱导执行工具。

**不变量**：

- **飞书面（网关进程）绝不执行工作区工具**：网关 bundle 行集不含任何工具/agent/session/llm 行，`tests/composition.test.ts` 解析真实 patch 锁死；admin 进程无 dsh-base，物理无工具执行面；
- 默认 `lightweight` 是**能力受限宿主 profile**（关闭本机子进程与委派入口），**不称沙箱**；强隔离只在显式 OCI profile：Podman rootless、非根、只读 rootfs、cap-drop、no-new-privileges、网络默认 none、pids/memory/cpus/tmpfs/storage 配额（`dsh-sandbox-oci`）；
- 沙箱环境白名单注入——密钥类条目绝不进容器；
- 目录分离 ≠ 沙箱：不得以路径布局宣称隔离。

**验证**：`tests/composition.test.ts`（网关硬边界、轻量 overlay 关闭子进程与委派、OCI overlay 替换本机执行）；`sandbox/oci/src/container.test.ts`（latest 拒绝、网络 none、安全参数、环境白名单无密钥）；`sandbox/oci/src/e2e.test.ts`（provision→exec→dispose 零残留）。生产多用户沙箱宣称还需路径/symlink/进程/挂载/网络/资源/清理逃逸套件（沿袭 lark-claw 验收门）。

### 3. 恶意或被篡改技能（供应链）

**攻击面**：安装的技能读取密钥、改政策、外传内容、夹带隐藏可执行依赖。

**不变量**：

- 技能是供应链输入：`skills/trust-manifest.json` 固定目录 SHA-256 摘要 + 版本 + 能力声明，预检失败（digest/version/capability 不一致、清单缺项）即**拒绝加载**（fail closed，`dsh-skill-trust`）；
- 技能发现只扫描受审 `skills/` 根（不含项目/用户默认根）；preset 未授权的受信技能以同名 shadow 隐藏（`executor.ts applyPresetSkillPolicy`）；
- 运行审计记录模板身份与技能清单（`lark/run/preset` 事件先于提示词落盘）。

**验证**：`skill-trust/src/preflight.test.ts`（全清单绿、篡改任一字节拒绝、版本/能力不一致拒绝、清单覆盖全部目录）；`tests/skills-discovery.test.ts`（发现只扫受审根）。lark-claw ADR-0004 的"版本化声明式模板 + 不可变平台政策在模板外"以 presets + bundle 层存续。

### 4. 凭证与密钥泄漏

**攻击面**：密钥值出现在日志、卡片、模型上下文、事件、artifacts、Git、错误响应或进程环境外传。

**不变量**：

- 密钥只以**凭证引用**出现（env 变量名经 `dsh-credentials` 解析）；cordis.yml 只写引用名；
- `.env` 是不可读、不可迁移的本地密钥边界：源码/日志/文档/卡片/事件只允许清理后的变量名或凭证引用；
- 配置缺失 **fail loud**（非零退出 + 可行动报错，绝不静默降级）；mem0 遥测 env 变异是唯一已记录的进程级副作用（SPEC memory.md §9）；
- 附件内容块带不可信数据警示（`BOUNDARY_BLOCK`），密钥模式不入模型可见块。

**验证**：`tests/clean-env.test.ts`（凭证缺失各 bin 非零退出）；`gateway/src/index.test.ts`（"消息日志不记录用户、会话或正文"）；`sandbox/oci` 环境白名单测试（密钥绝不注入容器）。

### 5. 伪造/重放飞书事件与卡片回调

**攻击面**：重复、过期或伪造的平台事件重放工具动作或审批；卡片载荷被当作授权证据。

**不变量**：

- **卡片回调载荷只是服务端状态引用，永不是授权证据**——回调处理先过授权（allowlist 用户/群），审批解答按 interactionId + Scope 幂等（`dsh-lark-approval`）；
- 事件去重（eventId 窗口幂等）；授权在去重之前（未授权消息不产生任何运行）；
- 跨进程控制面只信 loopback + 共享令牌（worker HTTP `WORKER_TOKEN`；admin 0.0.0.0 绑定强制 Bearer 且恒定时间比较）；
- cron 投递 at-least-once + 投递租约，动作侧幂等。

**验证**：`gateway/src/index.test.ts`（陌生回调零副作用、eventId 幂等）；`approval/src/index.test.ts`（重复答案幂等、跨 scope 送达拒绝）；`admin/src/index.test.ts`（无/错令牌 401）。

### 6. 知识与附件内容注入（沿袭 lark-claw）

**攻击面**：被索引文档或附件内容指令模型绕过政策或泄露其他数据。

**不变量**：检索文本与附件内容块是**不可信证据**而非系统指令（`BOUNDARY_BLOCK` 固定附加）；平台强制政策在 bundle 层（`dsh-lark-base`），位次高于模板与检索内容；知识引用随回答展示（`lark/knowledge/citations` 落盘）；不以检索文本授予任何能力。

**验证**：`uploads/src/index.test.ts`（边界块进入 `lark/run/context` 且先于提示词落盘）；引用事件落盘重放（`contracts/src/events.test.ts`）。

### 7. 模型断言非证据（沿袭 lark-claw）

**攻击面**：模型声称执行了命令/验证了文件，而宿主未观测到。

**不变量**：**模型可见 ⟺ 已落盘**——进入模型请求的一切可从 session log 重建（`lark/run/context`、`lark/run/preset`、`lark/message/in` 先落盘后进提示词）；工具观测是结构化事件而非助手文本；cron 结局按宿主观测的生命周期事件回填，不按模型自述。

**验证**：`contracts/src/events.test.ts`（落盘→重放一致）；`run/src` 事件流测试（NDJSON 流即 session 事件）。

## 安全验收门（沿袭并 dsh 化）

生产多用户宣称需要自动化测试覆盖：跨 scope 数据库查询/检索/工作区/会话/凭证/卡片（域 1、4、5）；沙箱逃逸套件（域 2，OCI profile）；技能供应链预检（域 3）。**通过功能性聊天测试不足以支撑任何隔离或私有性宣称。** 组合硬边界（网关无工具行）由 `tests/composition.test.ts` 在 CI 逐次锁死。

## 与 lark-claw 威胁模型的差异记录

- Pi SDK 条目移除（运行时换 dsh；"never pass gateway credentials to Pi"收敛为网关组合物理无 agent/工具行 + 凭证按组合分发）；
- Pi 会话/工件存储条目换成 DSH session log（JSONL + SQLite 查询）与 `.uploads`/`.workspaces` 目录；
- 新增组合层（bundle patch/overlay）与 `lightweight ≠ 沙箱` 的显式命名纪律；
- lark-claw ADR 存续判定见蓝图附录 A。
