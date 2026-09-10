# 发布与部署通道（M5 决策）

## 0. 生产目录职责

源码仓库使用 `apps/`、`packages/`、`infra/`、`presets/`、`skills/`、`docs/`、
`scripts/` 和 `tests/` 的常规开源项目布局。VPS 的 `/opt/dsh` 是部署根，
不是可写源码工作树：

```text
/opt/dsh/
├── current -> releases/<release-id>
├── releases/<release-id>/   # 不可变运行包
├── runtime/node/             # 固定 Node 运行时
├── deploy/migration/         # 一次性迁移工具
├── incoming/                 # 暂存输入
└── build/                    # 历史候选，保留用于审计和回滚
```

每个生产 release 必须包含 `apps/`、`packages/`、`presets/`、`skills/`、
`infra/`、`scripts/`、`node_modules/` 和根级锁文件，并写入
`.dsh-release-manifest.json`。测试工作区、跨平台路径、运行数据和缓存不得
进入 release。运行数据统一位于 `/var/lib/dsh`，systemd 只通过
`/opt/dsh/current` 启动应用。

release 根禁止出现 `patches/` 或 `pnpm.patchedDependencies`；依赖包自身随原包
发布的内部 patches 目录不属于根级补丁，不得据此修改或删除上游内容。

## 1. 发布通道决策（蓝图 §9 风险表第 2 项落定）

- **现状**：`@deepseek-ai` npm 作用域需组织权限，本仓库暂不具备 → **不发布 npm 包**；
- **分发策略**：仓库私有，按 **`file:` 依赖 + git 归档** 分发（部署机 clone/归档后
  `pnpm install --frozen-lockfile` 即可运行）；dsh 生态包保持精确锁版本
  （当前源码核心包为 0.1.5-rc.1，`pnpm-lock.yaml` 固化；不等同于生产版本）；
- **升级窗口**：dsh rc 升级作为里程碑前置任务；更新精确版本后执行
  `pnpm install --frozen-lockfile`、官方完整性、品牌、组合与全量门禁。任何官方包
  内容漂移、自有插件公开 seam 不兼容或 release manifest 校验失败都必须使升级失败；
- 未来获得作用域权限后：包 publishConfig 为 `@deepseek-ai`、registry 走内部源，
  切换不影响行集（bundle 引用包名不变）。

### 1.1 MewClaw 品牌插件升级协议

品牌只由自有 `dsh-lark-atw-brand` 客户端插件、公开 slots、WebServer transform/route
与 Auth Edge 标准路径代理实现；不修改官方 UI/Web 包，不复制上游 bundle 覆盖。
升级 DSH 时必须按以下顺序执行：

1. 更新 `package.json` 与 `pnpm-lock.yaml` 中的精确 DSH 版本；
2. 核验品牌插件使用的 slots、transform 和 route 仍是新版本公开契约；
3. 运行 `pnpm verify:official-integrity`，确认官方包内容、根清单和 lockfile 无补丁映射；
4. 依次运行 `pnpm verify:dsh-brand`、定向组合测试、`pnpm typecheck`、
   `pnpm lint`、`pnpm build`、`pnpm smoke` 和 release validator。

任一门禁未通过前不得接受升级或重启生产服务。

发布顺序：源码验证通过 → 说明影响与回滚并确认生产切换 → 生产测试通过 → 提交和推送远程。会话格式变化须核验旧日志转换和新代写入后的回滚边界；保留旧 release 不等于可无损回退新增会话数据。

## 2. 部署拓扑与端口交接

| 进程 | 迁移期端口 | lark-claw 旧端口 | 交接步骤 |
| --- | --- | --- | --- |
| worker（lark-run） | 开发 8788；生产 18788 | 8787（pi-worker） | Linux production overlay 是生产端口唯一来源 |
| admin | 开发 8791；生产 18791 | 8790（admin-api） | Linux production overlay 是生产端口唯一来源 |
| gateway | 无 HTTP 面 | 无 | — |

supervisor（infra/windows）已对接新 bins：`apps/lark-gateway/dist/main.js`、
`apps/lark-worker/dist/main.js`、`apps/admin/dist/main.js`；worker 健康
`/healthz`、admin 健康 `/api/admin/healthz`（Bearer ADMIN_TOKEN，从服务环境
注入）；gateway 经 IPC `lark-status` 心跳（apps/lark-gateway main.ts 上报
lark/connection 状态）。

## 3. 备份与保留

- **PG**：`scripts/backup-postgres.mjs` 执行 `pg_dump` 便携备份；调度与保留策略由
  部署配置负责，生产操作前验证目标目录、摘要和恢复边界；
- **会话日志**：`scripts/retain-sessions.mjs <days>`（默认 30 天，删旧 .jsonl；
  supervisor 周任务调用）；
- **上传/工作区**：`.uploads`/`.workspaces` 按运行态目录语义保留（不自动清理，
  配额治理 M5 观测后决定）。

## 4. 审计清单（docs/evidence/m5-hardening.md 记录观测证据）

- 密钥纪律：凭证只经引用；仓库追踪文件无密钥字面量（每轮扫描）；
- 依赖许可：`pnpm licenses list` 归档（证据文件）；
- 日志面：worker/gateway/admin 日志脱敏（错误只记 name/message）；
- 演练清单：重复事件去重、限流（队列/并发）、卡片回调过期（approval TTL）、
  断连重连（WS + 心跳容忍）——机制已实现并有单测；干净环境回滚/恢复演练
  需真实部署执行（用户辅助验收项）。

## 5. 负载与延迟目标（显式记录，部署后实测）

- 端到端（消息 → 处理卡）< 2s（p95）；无进展窗口内卡片增量 < 1s；
- 运行吞吐：per-user 串行 + 全局并发 4（可配）；cron 扫描 10s 轮询、领取批次 10；
- 检索延迟目标 < 3s（p95，真嵌入实测约 2.7s 全链路）。
