# 本地工作区云端配套

桌面 `1.0.0` 保留云端账号和模型，本地 Harness 提供用户原生授权的本机文件工具。云端旧 workspace、Shell 和双向同步桥接仍由独立 overlay 控制；云端未启用配套时切换报未连接，不显示已启用。

本地模式不会创建本地账号模型或复制供应商 API Key。桌面只用当前账号 Cookie/CSRF 请求 Auth Edge 的固定推理入口；Auth Edge 根据账号默认模型读取服务端加密配置并在服务端调用上游。模型目录只返回无凭证元数据，未配置默认模型时返回 `CLOUD_DEFAULT_MODEL_REQUIRED`。

## 配套代码

- Auth Edge：`packages/auth/edge/src/desktop-workspace.ts` 与 `server.ts` 入口，位于现有认证与 CSRF 检查之后；校验当前用户拥有会话。
- Worker：`packages/desktop/workspace`，包名 `dsh-lark-desktop-workspace`；共享 Host：`packages/desktop/host`。通过 Cordis 注册内部路由、工具、会话日志与 guard；不修改官方包。
- 默认保持 `enabled:false`，使用 `config/desktop-workspace.patch.yml` 显式启用。Auth Edge `AUTH_DESKTOP_BODY_LIMIT` 默认 8 MiB，不扩大普通 RPC 体积。Shell 超时应小于 Worker requestTimeoutMs，并为回传预留轮询余量。
- Worker 的 `tokenRef` 必须引用当前部署既有的 Worker 凭证，与 Auth Edge 的 Worker 认证配置一致。禁止把实际 token 写入配置示例、源码或日志。
- Worker 必须提供插件声明的 webServer、credentials、sessions、sessionPersistence、tools、larkScopeIndex 服务；先在隔离环境确认依赖完整再启用。

## 发布前验收

1. 云端标准构建、完整 Auth Edge 定向测试及类型检查已验证；上线前仍应按实际部署组合复跑。
2. 构建该独立 Worker 包，在隔离 staging 配置 Cordis 插件与凭证引用，验证已有 Web 会话不受影响。
3. 用测试账号验证登录保持、退出登录、三种桌面布局、原生选择目录，以及云端模型的目录列举/读取/条件写入。
4. 验证跨用户访问、根外路径、子会话绕过、旧 revision、断线、Worker 重启均拒绝越权且不回退服务器工具。
5. 本轮交付 master/desktop 源码，不部署生产；本地电脑合并自己的 desktop-dev。不得将整个 desktop 分支反向合并作为配套发布。

离线入口：`node apps/desktop/verify-workspace.mjs D:/AI/dsh/MewClaw-desktop-candidate`。
桌面包入口：`node apps/desktop/verify-package.mjs D:/AI/dsh/MewClaw-desktop-candidate`。
