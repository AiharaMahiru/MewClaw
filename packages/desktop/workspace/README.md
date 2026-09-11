# 云端桌面工作区插件

此目录是 `dsh-lark-desktop-workspace` 的唯一实现。Auth Edge 认证、校验 CSRF 与会话归属后，使用受管 Worker 凭证访问 `/internal/desktop-workspace`。文件工具和 Shell 仅向当前授权桌面投递请求；同步云端目录来自服务端认证资源，且须与会话持久化 cwd 相同。

Worker bundle 默认挂载 `enabled: false`：不暴露新桌面工具，不接受绑定，但保留已持久化本机模式的 guard。通过 [可选 overlay](../../../config/desktop-workspace.patch.yml) 显式启用，`tokenRef` 与 Auth Edge 的 `WORKER_TOKEN` 引用相同凭证。不要删除插件行来关闭桥接，否则无法继续保护已有本机模式会话。

`desktop_workspace` 提供 list/read/write；`desktop_shell` 提供 command/path。两个工具都进入官方工具结果日志；模型无法授予本机权限。普通浏览器只显示工作区状态，授权按钮仅存在于桌面 Host 提供的客户端。

绑定事件在 `dsh-lark-contracts` 中统一注册；连接代次仅内存，持久化 generation 是公开 revision。Worker 重启后保持本机断线态；会话需由官方 Web 会话生命周期装载后才可重新绑定。落盘失败会拒绝后续读取状态，不能回退服务器工具。

工具预检通过官方只读持久化句柄读取未加载父会话，不把普通归档云端父链误判为错误；句柄使用后关闭，读取失败或本机父链仍拒绝绕过。同步检查与工具切换检查在同一执行链生效。

部署和生产测试不由 Git 推送自动执行。未授权状态不操作服务器目录、不更改旧会话；启用后产生的绑定日志必须随新版本一起保留。回滚需先撤销绑定并保留事件读取与 guard 能力，不能仅把代码切回不认识事件的旧版本。

验证：`pnpm exec tsc -b packages/desktop/workspace packages/desktop/workspace/tsconfig.client.json`；`pnpm exec vitest run packages/desktop/workspace packages/auth/edge/src/desktop-workspace.test.ts`。
