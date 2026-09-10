# 桌面工作区 Shell 与同步

用户于 2026-09-10 明确扩大首版范围：原先只含 list/read/write 的桌面工作区增加本机 Shell 与目录双向同步。共享能力进入 `packages/desktop`，桌面专属的 Electron 原生授权和 WebServer Provider 留在 `apps/desktop`。

官方 Shell 与文件 Consumer 复用公开服务，不重写进程树管理。官方 FileSystem 缺少二进制条件发布和删除，因此同步增加轻量 Node Provider；通过受管凭证、会话归属和服务端 root 派生连接两端。Shell 授权不是文件目录授权，cwd 不是 OS 沙箱。同步副作用不自动重试，冲突保留两端，删除和替换先保留恢复版本。

测试门禁分别覆盖真实临时目录、官方子进程、认证/CSRF、工具 guard、持久化失败和离线 HTTP 全链路；构建与 Windows 实机验证分开记录。不修改官方包，不把无密钥候选测试称为生产模型验收。
