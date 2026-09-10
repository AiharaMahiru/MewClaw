# DSH Linux Production Runtime

`dsh-linux-production-runtime` 提供 Debian 生产 manifest、包锁、边界校验、cutover 状态机、
systemd/Nginx 渲染和无 shell 的部署命令计划。它不声明 Cordis service，也不直接修改宿主机。

生产组合按顺序应用 `apps/lark-worker/full.overlay.yml`、`apps/lark-worker/oci.overlay.yml`、
`infra/linux/overlays/worker.production.yml`；Gateway 与 Admin 分别应用同目录的 production overlay。
Worker Web 端口仍由 app CLI 的 `--port 13081` 显式设置。

## 当前状态

本地实现和无密钥测试已具备，**尚不能直接执行 VPS 部署**。进入 stage 前必须同时满足：

1. 父任务 2 的双端不可变 manifest 和隔离恢复证据已完成；
2. 远端 APT candidate、deb SHA-256 和 Node runtime artifact 与 `production.lock.json` 完全一致；
3. release、pnpm lock、production lock、品牌补丁和构建产物摘要已写入 runtime manifest；
4. 候选内部端口重新枚举且所有权明确；
5. rootless Podman、独立 PostgreSQL、systemd unit 和 Nginx candidate 均通过实机验证；
6. `.env` 仅完成不回显的原字节传输，源/目标摘要一致且目标为 `dsh:dsh 0600`。

TypeScript 层生成并校验无 shell 的操作计划；`deploy/` 当前只实现只读 preflight、APT closure、
host bootstrap 和不激活 `current` 的 immutable stage。独立 cluster、Node runtime、受控 env、systemd
与服务切换仍须由后续受控命令入口实现和审查；不得临时改成手工 shell 散命令。

## 本地门禁

```bash
pnpm linux:test
pnpm linux:build
pnpm exec eslint infra/linux
pnpm exec tsc -p tsconfig.test.json --noEmit
git diff --check
```

远端包锁只读复核使用：

```bash
apt-cache policy postgresql-17 postgresql-client-17 postgresql-17-pgvector podman uidmap slirp4netns fuse-overlayfs
apt-cache show postgresql-17=17.9-0+deb13u1
apt-cache show postgresql-client-17=17.9-0+deb13u1
apt-cache show postgresql-17-pgvector=0.8.0-1
apt-cache show podman=5.4.2+ds1-2+b2
```

## Stage 验证命令

以下命令只在独立 candidate 和恢复点准备完成后运行，参数必须由已校验 manifest 转成 argv：

```bash
systemd-analyze verify /etc/systemd/system/dsh-auth.service /etc/systemd/system/dsh-worker.service /etc/systemd/system/dsh-gateway.service /etc/systemd/system/dsh-admin.service
ps -p <master-pid> -o pid=,ppid=,args=
/www/server/nginx/sbin/nginx -t -c /www/server/nginx/conf/nginx.conf
sudo -u dsh podman info --format json
pg_isready -h 127.0.0.1 -p 15432
psql -h 127.0.0.1 -p 15432 -d dsh -c "SELECT extversion FROM pg_extension WHERE extname='vector'"
```

上述命令不得携带密码、token、Cookie 或 `.env` 内容。数据库认证使用受限凭证文件或服务环境，
不进入 argv、日志或证据。

## 切换与回滚入口

- `planReleaseSwitch()`：为 `/opt/dsh/current` 生成临时 symlink、目录 fsync 和原子 rename；
  rollback 保留旧 release target，不删除任一 release。
- `rewriteNginxLoopbackProxyPasses()`：只接受并同时替换 live vhost 中恰好两条 loopback
  `proxy_pass`，数量漂移即拒绝生成 candidate。
- `planNginxUpstreamSwitch()`：为宝塔 active vhost 生成同目录摘要备份、原子 rename、实际
  master PID 检查、`/www/server/nginx/sbin/nginx -t -c /www/server/nginx/conf/nginx.conf`
  和 `kill -HUP <master-pid>` 的 argv 计划；不依赖 inactive 的 `systemctl nginx`。
- `transitionRuntimePhase()`：只有 delta 为空时允许 `promoted -> rolled-back` 自动回切。
- delta 非空时必须进入 `rollback-pending`，DoorAgent 与 DSH 保持只读；完成 durable reference
  对账和补偿后，才允许 `rollback-pending -> rolled-back`。
- `sealCutoverEpoch()` 后拒绝新增 delta；序号缺口、重复 operationId 或非法引用均 fail closed。

任何回滚都必须绑定 epoch、迁移 `runId`、源/目标 manifest 摘要和旧 release/upstream target。
