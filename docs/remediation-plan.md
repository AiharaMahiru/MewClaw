# 完善清单（remediation plan）

> **当前状态（2026-09-09）**：历史批次均已完成；R-14 的插件全局环境写入已移除，遥测由 systemd 在启动前配置；R-16 已确定私有仓库 `file:` + git/release archive 分发。下表保留当时问题与方案，作为历史审计记录，不代表当前仍开放。

> 后续能力扩展（生图/邮件/Firecrawl 升级）另见 [evidence/capabilities-image-mail-firecrawl.md](evidence/capabilities-image-mail-firecrawl.md)。

来源：2026-08-16 两轮审计——①对照 Cordis primer 五概念的合规审计（插件生命周期 / 服务查找 / 事件系统）；②对照 `docs/component-map.md` 与 `D:\AI\lark-claw` 实盘的迁移逐项核对。每项标注证据位置、方案、验收标准与规模（S ≤ 半天 / M ≤ 2 天 / L > 2 天）。

执行纪律（仓库既有规则，逐条适用）：

- **SPEC 先行**：R-06 / R-17 / R-18 / R-20 属行为变化，实施前先改对应 SPEC（`docs/specs/`），行为变化记入 SPEC §9。
- 每项收尾跑针对性检查：涉及包测试 + `pnpm typecheck` + `pnpm lint`；全套留给批次收尾。
- 模型可见 / 用户可见输出变化必须加可无密钥重放的快照；证据归档 `docs/evidence/`。
- P3 决策项未经拍板不得开工；拍板后在本文件勾选决议。

## 批次一（P0 + P1：在途欠账与规范修复，均为 S）

| # | 项目 | 证据 | 方案 | 验收 | 规模 |
| --- | --- | --- | --- | --- | --- |
| R-01 | 附件内容驱动识别收尾（在途） | `HANDOFF.md`；改动已落 `packages/lark/uploads/src/{detect,extract,index}.ts` + 测试，未构建部署 | 复核现有改动 → 包测试/typecheck/lint → 构建 → 重启服务 → 实机验证（图片/`docx`/`xlsx`/`csv`/无扩展名源码） | 真实飞书发图返回视觉分析而非"无法读取"；不误报"加密/损坏"；快照可重放 | S |
| R-02 | admin 路由 disposer 泄漏（高危） | `packages/lark/admin/src/index.ts:210,261,280`：`webServer.register` 返回值丢弃，且 host-webserver 实现是裸 Map 插入、无内部 ctx 绑定 | 三处包进 `ctx.effect(() => webServer.register(...))`（对照 `knowledge-postgres/src/index.ts:127-129` 的 disposer 模式） | 新增单测：dispose 后 webServer 注册表不含 3 条路由 | S |
| R-03 | cron PG 池无关闭 disposer | `packages/lark/cron/src/index.ts:60`：`new PgCronDatabase` 无 `ctx.effect` 清理（`close()` 已存在但无人调用） | 加 `ctx.effect(() => () => void database.close())` | 单测：dispose 后 `pool.end` 被调用 | S |
| R-04 | teardown 竞态（两处） | `packages/lark/run/src/index.ts:38-48`（HTTP server）；`packages/lark/lark-ws/src/index.ts:107-121`（WS 连接）：异步启动完成前 dispose 则孤儿资源 | 加 `active` 守卫（对照 `packages/lark/lark/src/index.ts:50-53` 现有模式） | 单测：apply 后立即 dispose，无监听中的 server / 无 start 后未 stop 的 WS | S |
| R-05 | SessionEventMap JSDoc 缺失 | `packages/lark/contracts/src/events.ts:84-158`：8 个成员缺 `@param` 与 `@mode`（违反 AGENTS 核心规则 5 与 `docs/specs/contracts.md:59`） | 按框架样式补齐：每 payload 字段 `@param`；`@mode emit`（成员经 `session/event` 通道观察，样式基准 `@deepseek-ai/dsh-session/lib/types/index.d.ts:35-73`） | `docs/specs/contracts.md` 作者自检清单通过；typecheck | S |
| R-07 | run 包两处未声明服务访问 | `packages/lark/run/src/agent-bootstrap.ts:26`（`ctx.systemPrompt`）、`executor.ts:78`（`ctx.skills`）不在 inject | 两键补进 `dsh-lark-run` 的 inject（worker 组合恒有该二服务） | typecheck + run 包测试 | S |
| R-08 | card 节流定时器无 teardown | `packages/lark/card/src/index.ts:65-110` + `throttle.ts:37`：插件卸载后 pending drain 仍触发投递 | CardThrottle 增加 cancel 面；插件 disposer 清空 `throttles` | 单测：dispose 后到期不投递、不写日志 | S |
| R-09 | 事件 payload 类型洞 | `apps/lark-gateway/src/main.ts:50`（`{state: string}` 放宽）、`gateway/src/index.ts:97`（`runId` 未品牌化）、`cron/src/index.ts:77`、`run/src/run-coordinator.ts:39`（`as` 断言）、`gateway/approval` 测试 `as never` | 统一改用声明 payload 类型；测试去 `as never` | typecheck 零 `as` 于上述位置 | S |

## 批次二（P2：迁移文档修正，S–M；部分依赖批次三拍板）

| # | 项目 | 证据 | 方案 | 验收 | 规模 |
| --- | --- | --- | --- | --- | --- |
| R-10 | component-map 与实际不符（四处） | §2.2 admin"机器人模板管理、运行审计"未实现（实际仅 `/api/admin/knowledge` + healthz + 静态面，admin-web 仅 KnowledgePage）；§2.3 commands 含"/cron（列表/详情/编辑/暂停/删除）"实际命令集为 `/clear /handoff /runtime /todo /session /help`；§1 examples"可选保留"实际未保留；§2.4 uploads".artifacts 收集"未迁移（uploads/src 无产物代码） | 前三处改为如实描述并指向对应决策项（R-17 / R-18 / R-06）；第四处随 R-06 决议同步 | 与代码零矛盾；`docs/specs/` 交叉引用有效 | S |
| R-11 | AGENTS.md 悬空引用 | 硬边界条目引用不存在的 `examples/lark-samples/` | 删除该句或改为"lark-claw 的 examples/ 是参考材料（本仓库未引入）" | 无指向不存在路径的引用 | S |
| R-12 | 威胁模型与架构文档重写 | lark-claw 有 `docs/architecture.md`、`threat-model.md`、4 个 ADR；component-map §1 承诺重写为"docs/（architecture / threat-model / 蓝图 / 映射）"，二者在本仓库均不存在 | 以 dsh 实际架构（两进程拓扑、DSH session log、能力缝、bundle 组合校验、lightweight/OCI 双 profile）重写 `docs/threat-model.md`；安全不变量以 AGENTS 硬边界为基线，覆盖 ACL 查询内过滤 / 沙箱 / 技能供应链 / 凭证引用 / 卡片回调非授权证据五域；lark-claw 4 ADR 中仍然成立者提炼并入蓝图附录 | 威胁模型覆盖五域且每域含攻击面→不变量→验证测试指引；component-map §1 更新 | M |
| R-13 | SPEC §9 行为变化补记 | 去重（PG inbox → 进程内 LRU+TTL）与附件暂存（PG 队列 → 进程内 TTL 暂存）已记录；产物收集、ephemeral 卡删除、单例锁未记录 | 随 R-06 / R-20 / R-21 决议补记；不做即写"有意不迁移 + 理由" | 每个已删旧行为在对应 SPEC §9 有一行 | S |
| R-14 | mem0 进程环境变异 | `packages/memory/memory-mem0/src/index.ts:184`：`process.env.MEM0_TELEMETRY ??= "false"` 不可逆 | 优先改为 SDK 构造参数/显式 env 传递；无法参数化则在 SPEC 记录该全局副作用 | 插件加载不改写 `process.env`，或副作用已文档化 | S |

## 批次三（P3：决策项——逐项拍板后立项，本清单只记录选项与建议）

| # | 决策点 | 现状 | 选项与建议 | 拍板后规模 |
| --- | --- | --- | --- | --- |
| R-06 | `lark/artifact/created` 死契约：已声明、已消费（`gateway/run-flow.ts:124`、`run/run-observer.ts:102`）、零生产者；与 lark-claw 产物交付（workspace-artifact-store + artifact-candidates + 网关产物行下载）同源缺失 | **建议补生产者**：uploads 运行结束后收集交付物（继承旧白名单/大小上限语义）→ `session.append` → 网关产物行；SPEC uploads.md 先增补。备选：删契约 + 消费分支并记行为变化 | M |
| R-15 | cron 能力缝契约内嵌 Provider 包（`dsh-lark-cron`），Consumer `dsh-tool-cron/src/index.ts:13` 值导入 `validateSchedule`，与 knowledge/memory 三包模式不一致 | a) 契约移入 `dsh-lark-contracts`（**建议**，零新包）；b) 独立 Definition 包；c) 记录接受偏差（平台专属缝论证） | S |
| R-16 | 根 `package.json` 与 `packages/lark/lark` 包名重复（`dsh-lark`）；发布作用域未定事项已逾期（README：M5 前确定 registry/作用域/`file:` 分发） | 发布准备时一并决议：根改名 `dsh-lark-workspace`（私有根不改生态名）+ 确定作用域；联动 `docs/release.md` | S |
| R-17 | 管理面范围：旧 admin 的 runs / conversations（含消息注入 + SSE）/ automation / system / artifacts 下载未迁移 | a) 记录"有意缩小"（**短期建议**；运行观察已有替代面：网关 `/session` 命令 + worker session-overview 端点）；b) M6 立项补运行审计页（数据源 session-overview，避免复刻旧 admin 七表） | a=S / b=L |
| R-18 | `/cron` 确定性管理命令：旧原生管理卡（分页/详情/编辑/暂停/删除）未迁移，仅剩模型面 `cron_schedule` 工具 | a) 补 `/cron` 命令，走 run-client → 既有 cron-control 端点（**建议**：确定性操作不耗模型、离线可管理；commands 包轻量表已预留扩展）；b) 记录降级为自然语言管理 | a=M / b=S |
| R-19 | 无消费者事件：`lark/bot/menu`（旧 bot-menu-command 语义）、`skill-trust/result` | bot/menu：接菜单处理或改 help 卡（**建议**接，旧用户体验延续）；skill-trust/result：标注观察型事件（供测试/日志）即可 | S |
| R-20 | ephemeral 卡 TTL 自动删除（旧 10s 删临时卡）未迁移 | 确认 dsh 卡片生命周期是否需要该语义（命令回执卡目前是否常驻）；需要则进 card 包节流层，不需要则记 R-13 | S |
| R-21 | 网关进程单例锁未迁移（旧 PG 单例锁） | 单实例部署由 `infra/windows` supervisor 托管，锁语义已被承担——**建议记录论证**（R-13）；多实例需求出现时再立项 | S |
| R-22 | lark-claw 旧仓库收尾：08-07~08-11 大改动（lark-cli skill、release zip）未提交 git；`packages/knowledge` 残留 dist；`workflow/` 原型未在映射表提及 | 旧仓库做最终固化 commit（迁移源封存）+ 映射表补两行"不迁移"记录；`workflow/` 原型留旧仓库 | S |

## 依赖与顺序

1. 批次一内部无依赖，可并行；R-01 优先（唯一用户可见线上欠账）。
2. R-10 / R-13 依赖对应 P3 决议（R-06 / R-17 / R-18 / R-20 / R-21），拍板前先按现状如实修正、拍板后回填。
3. R-12（威胁模型）独立，可与批次一并行推进。
4. R-16 挂靠发布准备（`docs/release.md` 部署演练）触发。
