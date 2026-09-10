# 桌面工作区源码验收（2026-09-10）

范围：Web DSH 0.1.5-rc.1 与桌面独立 DSH 0.1.2-rc.1；Linux / Node 24。官方依赖未修改，无生产重启或数据迁移。

## Web 与共享能力

- `pnpm build`、`pnpm typecheck`：通过。
- `pnpm exec vitest run packages/desktop packages/auth/edge/src/desktop-workspace.test.ts packages/auth/edge/src/server.test.ts packages/lark/contracts/src tests/composition.test.ts`：17 文件、98 测试通过。
- 后续同步边界小修补跑 `packages/desktop/host/src/sync.test.ts`：5 测试通过。
- 变更文件 ESLint、`pnpm verify:dsh-brand`、`pnpm verify:official-integrity`：通过，官方补丁豁免为 0。
- 真实配置合并测试覆盖默认关闭、显式 overlay 启用，以及 Worker 直接依赖解析；不是仅检查 YAML 文本。

## 桌面候选

- 版本：`0.1.0-desktop.5`。候选独立安装后 `npm run build` 完成共享 Host、社区桌面和 Cloud Provider 构建。
- `node apps/desktop/verify-workspace.mjs <独立候选绝对路径>`：12 文件、36 测试通过，打印 `WORKSPACE_OFFLINE_VERIFIED`。
- HTTP 集成覆盖 Auth Edge 所有权校验→Worker→本机文件创建、未授权 Shell 拒绝、原生授权回调取消/允许、真实官方 Shell 执行/撤销、云端与本机真实目录双向复制。
- 单测补充二进制与嵌套路径、双边修改冲突、摘要条件更新、删除恢复元数据、跨端大小写冲突、超限、路径和符号链接拒绝、超时、注销与持久化失败。
- 三模式布局及既有 Cloud Provider 客户端测试通过。上游包缺少 source map 产生 Vite 警告，不影响通过结果，未改动官方包去消除警告。

## 明确未验证

没有新版 Windows 安装包、Windows/macOS 实机或生产模型验收。原生授权对话框的选择在无密钥集成中通过 Host 回调模拟，不能当作已完成 Windows 点击验收。生产桥接默认关闭，需要单独部署 Auth Edge/Worker 并启用 overlay。同步不包含空目录/权限位，不提供离线写入重放或 OS 沙箱保证。
