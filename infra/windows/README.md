# infra/windows — Windows 服务 supervisor

自 lark-claw `packages/service-runtime` + `infra/windows/lark-claw-service.ps1` 整体平移（M0），职责不变：

- 以计划任务（无提权、登录时运行）承载 supervisor；
- 编排四个子进程：worker / gateway / admin / postgres，做健康检查、心跳判活、日志轮转、优雅关停；
- `dsh-lark-service.ps1` 为任务管理入口（install/uninstall/start/stop/restart/status/logs），任务名 **MewClaw**；
- **M5 已对接新 bins**：`apps/lark-gateway/dist/main.js`、`apps/lark-worker/dist/main.js`、`apps/admin/dist/main.js`；worker 健康 `/healthz`（默认 8788，env `LARK_WORKER_PORT` 覆盖）、admin 健康 `/api/admin/healthz`（默认 8791，env `ADMIN_PORT` 覆盖，Bearer ADMIN_TOKEN 注入）、gateway 经 IPC `lark-status` 心跳（连接状态上报）。端口交接见 [docs/release.md](../../docs/release.md)。

对应根 `package.json` 脚本：`pnpm service:*`。环境变量 `DSH_LARK_ROOT`（原 `LARK_CLAW_ROOT`）指定仓库根。
