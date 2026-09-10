# 桌面 Host 共享能力

SPEC：[桌面工作区](../../../docs/specs/desktop-workspace.md)。此包不启动服务器、不创建 Cordis 单例；由 Worker 和桌面插件组合 Consumer/Provider，运行时仅依赖官方 FileSystem、Shell 与 Node 标准库。

- `LocalWorkspaceFiles`：授权目录内的文本读、列和条件写入。
- `LocalWorkspaceShell`：官方 `ShellExecutor.resolve/run` Consumer；创建实例即代表桌面 Host 已获得原生独立授权，撤销通过 AbortSignal 终止运行。
- `SyncEndpoint` / `NodeSyncDirectory` / `SyncEngine`：二进制同步能力定义、Node Provider 与三方比较 Consumer。

同步默认排除 `.env*`、`.git`、`node_modules` 和内部状态目录；拒绝符号链接和不便携文件名。首次同名不同内容、两边同时修改、删除对修改均显示冲突。空目录和权限位不同步。替换/删除的原内容保留在 `.mewclaw-sync/recovery/`，不会自动清理；恢复文件以唯一 ID 命名，旁边的 `.json` 记录原相对路径、摘要和时间，由用户确认后恢复。

本机 Shell 以当前 OS 用户权限执行，不是目录沙箱；同步仅对同进程变更串行化，不宣称抵御恶意本机进程更换路径。目录内容和命令输出在用户授权后会发送云端。断线后不自动重放写入或执行命令。

Web 验证：`pnpm exec vitest run packages/desktop/host`。桌面验证：独立候选执行 `npm run build --workspace mewclaw-host`，再运行桌面 `verify-workspace.mjs`。Windows 分支使用官方 PowerShell Provider；Linux/macOS 使用官方 Bash Provider。
