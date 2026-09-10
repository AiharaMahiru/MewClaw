# infra/postgres — 便携 PostgreSQL 运行器

自 lark-claw `packages/postgres-runtime` 整体平移（M0），职责不变：便携版 PostgreSQL（EnterpriseDB）+ 自编译 pgvector + pgweb 管理台，提供安装 / 初始化 / 启停 / 状态 / 迁移能力。

- 对应根 `package.json` 脚本：`pnpm postgres:*`（install/setup/start/status/stop）与 `pnpm postgres:web:*`。
- `compose.yaml` 提供 Docker 版 pgvector 作为备选，不强制使用；启动前必须从外部注入 `POSTGRES_PASSWORD`。
- 运行只需 Node；数据库配置必须显式提供包含本地凭证的 `DATABASE_URL`，缺失时立即失败，不在仓库保存默认密码。

迁移说明（蓝图 §9）：pgvector 便携构建沿用 lark-claw 的 EnterpriseDB + 自编译流程，**整体平移、不改逻辑**。
