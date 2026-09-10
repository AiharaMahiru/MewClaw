# DSH 0.1.5-rc.1 源码升级

状态：2026-09-10 已经用户确认切换到生产 `R3-dsh-015-rc1-presetfix-20260910`，基础健康检查通过，等待用户实际功能测试；尚未提交或推送。开发目录 `/opt/dsh/upgrade-015-source`，分支 `upgrade/dsh-0.1.5-rc.1`；目标为 master，不直接同步 desktop。

生产发布证据：候选90790个文件摘要一致；六个DSH服务的实际cwd均为新release，NRestarts均为0；公网首页、healthz、manifest均HTTP200。停服备份位于 `/opt/dsh/backups/R3-before-dsh-015-20260910`，会话tar经compare和SHA-256校验。新增三个已验证v3文件后，最新生产95个会话全部通过官方只读恢复；旧日志全部保留。PostgreSQL、Nginx、SSH进程基线未变。尚未证明真实模型续聊、工具执行、飞书交互和子代理冷恢复，用户自行实际测试后再决定提交推送。

## 依赖范围

- DSH 核心与官方插件统一 `0.1.5-rc.1`，49 个 package.json 更新；最终安装身份和完整依赖以锁文件为准。
- 社区 Web 合集 `0.3.19`，better-sidebar `0.18.1`，dsh-context `0.48.0`。合集 `0.3.20` 引入 alpha 侧栏，此候选不采用；perf `0.3.14`、desktop-launcher `0.3.13` 已是各自 latest，保持不变。
- 官方包不修改、不使用 patchedDependencies；独立 Cordis/Schemastery 包保持兼容精确版本，不把其版本改成 DSH 版本。

## 自有消费方适配

用户生产验收发现模式延迟挂载未覆盖：persona 的必填字段变为 `prefix`，部署配置变为 `personaPrefix`，全能优化模式的人设 section 拆为 prefix/suffix，工具呈现名变为 `ptc`。修复已发布至presetfix候选；官方schema及逐预设真实挂载回归通过，解包候选lightweight/full/OCI三组合共21次挂载通过。六服务实际cwd、新字段及公网200已核实；不等同于真实模型执行通过。修复切换没有再次迁移历史数据，当前会话备份位于 `/opt/dsh/backups/before-presetfix-20260910`，前一版0.1.5保留，不回滚或覆盖新消息。

- 会话查询改用 `SessionPersistence.list()` 的 snapshot header；只读日志用官方 `open(id, 'read')`、`read()` 和 finally `close()`，不占写所有权。
- Agent setup 使用官方回调传入的 Agent，不再依赖移除的 `ctx.agent`。
- 文本流从官方 `agent/assistant-stream` 接收，用独立临时 wire 行传给网关，完整 Scope/runId 校验不变。最终正文覆盖同一 step 的临时正文；不伪造持久化 `assistant/chunk`。
- OCI 普通 SubprocessHandle 不再暴露官方已删除的 pid 字段；终端 Provider 和容器隔离政策未扩展。
- 私有模型适配器补齐官方模型错误目录字段。新版目录将 Astra 标记为 text/image；此处目录测试不是远端模型图片请求 E2E。
- ESLint 仅排除两份 esbuild 生成的浏览器 bundle；TypeScript 源码仍完整检查，不修改生成 bundle 内第三方代码来消除 lint 告警。

## lightweight 能力变化

用户要求取消 lightweight 的执行能力裁剪。其 Host 配置与 full 对齐，保留默认 `lark-lightweight`；该 preset include 官方 standard，不再复制裁剪版工具清单。Shell、搜索、任务和委派能力由实际 Host Provider 提供。账号与工作区授权、审批、system-only preset roots 保留；pet 和外部控制等既有产品禁用项不因本次要求重开。

lightweight 名称现在表示保留的默认模式入口，不表示安全隔离等级。full/lightweight 不能宣称 OS 沙箱；OCI 会话仍在容器 Provider 中执行，不允许宿主回退。

## 会话迁移与回滚门禁

新版会话格式为 v3。官方 Provider 对支持的旧代日志进行只读转换，并在写打开时发布新代，保留旧代文件；无效旧记录会明确拒绝，不自动猜测修补。

无密钥测试 `tests/dsh-session-migration.test.ts` 验证完整 v0 回合转换、正文保留、只读不发布、写打开产生 v3 且旧代字节不变。它不是全部生产日志的兼容证明，生产切换前还需对冻结副本核验真实历史会话。

初次副本检查：93 个日志复制后哈希一致，90 个通过新版只读恢复；1 个因历史 `lark/message/in` 自定义事件被拒绝，2 个因旧 `subagent/descriptor` 的 descriptor version 2 被拒绝。官方历史迁移器在静态迁移链中拒绝这些记录，即便将自定义事件注册为当前已知类型也不能通过。

独立离线工具 `scripts/session-upgrade/` 已在批准的三个副本上验证：61 条飞书扩展按唯一 inbox 锚点原位保留，两个 descriptor 经新版 schema 验证后仅变更版本号；其余转换复用官方0→3链。新文件经全新官方 Provider 读取，与内存结果完整相等；合计93/93会话可读，源副本变化0。生产原件未改，未改官方包、未丢弃会话。详见[副本验收证据](evidence/dsh-015-session-upgrade.md)。副本读取通过不等于真实模型续聊或子代理冷恢复通过，生产数据转换仍须确认。

仅对离线副本执行（计划包含1至3项相对路径与固定SHA-256，权限0600；输出必须不存在）：

```sh
node --import tsx/esm scripts/session-upgrade/cli.ts /absolute/copy/sessions /absolute/new-output /absolute/private-plan.json
```

输出 `sessions/` 为新版官方日志，`originals/` 为原字节副本，`manifest.json` 为计数和文件摘要。命令拒绝生产路径，不能将其直接用于生产转换。

**不能把切回旧 release 等同于无损数据回滚**：新版本写入 v3 后，旧版未必认识或能看到该代新增内容。切换前备份并验证会话和索引，明确测试窗口的写入范围与恢复方案，保留所有新增代文件；不得直接还原旧数据覆盖新消息。Worker/Gateway 的临时正文协议需配套切换。

## 发布顺序

1. 源码构建、类型、lint、品牌/补丁策略、插件边界和定向/全量回归。
2. 独立候选检查真实运行入口与历史日志副本；说明服务影响、暂存数据和回滚办法，取得切换确认。
3. 生产测试会话、模式切换、工具、账号隔离和重连；通过后才提交并推送 master。

既有飞书账户中心未提交改动必须保留，不能直接覆盖它的源码或 client.js；若候选需要包含这些功能，应另行核验其差异及构建，不得把未验收改动混入本升级。
