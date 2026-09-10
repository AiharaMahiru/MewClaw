# 本地工作区云端配套

桌面 `0.1.0-desktop.4` 保留云端账号和模型，通过本机原生目录选择授权 list/read/write。云端未安装配套时切换应报未连接，不应显示已启用。

## 配套代码

- Auth Edge：`packages/auth/edge/src/desktop-workspace.ts` 与 `server.ts` 入口，位于现有认证与 CSRF 检查之后；校验当前用户拥有会话。
- Worker：`apps/desktop/plugins/workspace`，包名 `dsh-lark-desktop-workspace`。通过 Cordis 注册内部路由、工具、会话日志与 guard；不修改官方包。
- Worker 的 `tokenRef` 必须引用当前部署既有的 Worker 凭证，与 Auth Edge 的 Worker 认证配置一致。禁止把实际 token 写入配置示例、源码或日志。
- Worker 必须提供插件声明的 webServer、credentials、sessions、sessionPersistence、tools、larkScopeIndex 服务；先在隔离环境确认依赖完整再启用。

## 发布前验收

1. 在云端标准构建环境完成完整 Auth Edge 包的类型检查与测试；当前仅桥接 helper 严格编译和离线 HTTP 集成通过。
2. 构建该独立 Worker 包，在隔离 staging 配置 Cordis 插件与凭证引用，验证已有 Web 会话不受影响。
3. 用测试账号验证登录保持、退出登录、三种桌面布局、原生选择目录，以及云端模型的目录列举/读取/条件写入。
4. 验证跨用户访问、根外路径、子会话绕过、旧 revision、断线、Worker 重启均拒绝越权且不回退服务器工具。
5. 云端部署需单独授权；本次未修改 master、未推送或部署生产。不得将整个 desktop 分支反向合并作为配套发布。

离线入口：`node apps/desktop/verify-workspace.mjs D:/AI/dsh/MewClaw-desktop-candidate`。
桌面包入口：`node apps/desktop/verify-package.mjs D:/AI/dsh/MewClaw-desktop-candidate`。
