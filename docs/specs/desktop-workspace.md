# 桌面本地工作区 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | 桌面本地文件 Consumer 与云端桥接插件 |
| 位置 | packages/desktop/host；packages/desktop/workspace；packages/auth/edge；desktop 分支 apps/desktop/plugins/cloud |
| 角色 | Definition / Provider / Consumer |
| 状态 | implementing |
| 里程碑 | Desktop 1 |
| 关联 ADR | ADR-1、ADR-3、ADR-6 |
| 依赖能力 | 官方 FileSystem、tools、已认证 Scope、桌面原生目录选择 |
| 提供能力 | 受限文件操作与会话绑定的请求传输 |

## 1 目的与边界

用户确认工作区提供“云端 / 本地电脑”切换；两种模式继续使用云端账号和模型。2026-09-10 用户扩展范围：本机 Shell 与目录双向同步纳入本版。选择目录仅授权文件工具；Shell、双向同步分别经本机原生确认后启用，默认关闭。无离线副作用重放、无多设备自动接管。Shell 按当前系统用户权限执行，可以访问目录之外的资源，目录授权和 cwd 不是操作系统沙箱。

## 2 服务契约

本地文件 Consumer 复用官方 FileSystem 的 resolve/contains/stat/readText/listDir/writeText，不重写官方文件持久化。LocalWorkspaceFiles(fs,root,limits) 为一次本地目录授权所有；execute(operation,signal) 返回JSON结果或明确错误；撤销后不得继续处理新请求。operation 为 {action:'list'|'read'|'write',path:string,content?:string,version?:string}，必须为目录相对路径。read 返回不透明版本与正文；write 无 version 只允许创建，给出 version 才允许条件替换。

云端绑定必须携带完整已认证 Scope，模型参数不能指定账号/会话/设备。连接断开或绑定不可恢复时拒绝本地执行，不回退服务器目录。桥接使用固定云端 HTTPS 下的 /desktop-workspace 端点；浏览器或本地 Host 提交 sessionId 与动作，Auth Edge 校验 Cookie、CSRF 和会话所有权，从认证结果生成完整 Scope，经已有 Worker Bearer 转到内部端点。客户端提供的用户与 Scope 字段一律拒绝。绑定使用仅 Host 内存中的随机令牌，令牌及本机绝对路径不得进入会话日志或模型。动作包括 status、bind、poll、result、unbind；每个结果匹配请求ID、绑定代次和Scope，一次性消费。

## 3 配置契约

文件 Consumer limits 显式传 maxBytes、maxEntries，由插件 Config 提供：默认262144字节、500项；范围1024至1048576字节、1至2000项。root 仅来自用户原生目录授权；不从模型参数或浏览器任意路径恢复授权。

Shell Consumer 复用官方 ShellExecutor.resolve/run；配置 shellTimeoutMs 默认30000（1000–120000）、shellMaxOutputBytes 默认65536（1024–262144）。工具 desktop_shell 参数 command:string、path:string（默认相对根 .）；无 env、shell executable 或主机路径参数。撤销和插件卸载向正在运行的请求传播 AbortSignal，Provider 管理进程树。返回退出码、超时和有界 stdout/stderr，不返回 spill 路径；输出是用户授权上传到云端的模型可见内容。

同步 Definition 为 SyncEndpoint.snapshot/read/write/remove；NodeSyncDirectory 为二进制 Provider，SyncEngine 为双端 Consumer。官方 FileSystem 没有二进制写入/删除 API，因此仅同步 Provider 使用 Node 标准库，不增加第三方依赖。Config syncIntervalMs 默认5000（1000–60000）、syncMaxBytes 默认1048576（1024–4194304）、syncMaxEntries 默认2000（1–10000）、syncMaxTotalBytes 默认33554432（1024–268435456）；每会话单在途。同步默认排除 .git、node_modules、.env 及 .env.*、.mewclaw-sync，拒绝符号链接、特殊文件、不便携路径和大小写碰撞。相对路径以 / 分隔；配置不允许取消上述凭证和状态排除。

## 4 事件契约

文件读取和写入结果通过正常工具执行返回，进入官方工具结果事件。绑定与解除通过 session.append 和 sessions.flush 记录 desktop/workspace 状态后才允许执行；只记录执行地点和绑定代次，不记录凭证和绝对路径。Worker 重启从持久化状态恢复为本机断线态，直到重新授权绑定；不得自动变回云端。无额外隐藏模型输入。

## 5 模型可见面

提供 desktop_workspace 文件工具与 desktop_shell 命令工具，generic 呈现，参数根为 object。执行地点、相对路径、文件版本与结果由官方工具事件记录；模型不能开启 Shell 或同步授权。绑定本地工作区后通过 tools.guard 单调拒绝除 desktop_workspace、desktop_shell 及其受控 run_code 传输以外的工具；子代理不得另起云端执行绕过限制。切换仅在会话无运行工具时执行，有请求在途时拒绝切换。断线拒绝本机工具且继续维持其他工具禁用，不回退服务器。同步不向模型隐藏注入文件正文，结果只在用户同步状态中呈现，后续模型读取文件仍走正常工具事件。

## 6 行为契约

路径同时做相对路径语法验证与官方规范目标 contains 验证；符号链接指向根外拒绝。读前读后版本不同拒绝返回不一致正文；写入必须使用官方 createIfAbsent/replaceIfVersion，不无条件覆盖。目录列表不包含根外目标。读写体积和目录条数有上限，超限明确报错。

同步配对当前授权本机根与服务端登记的当前会话 resourcePath；服务器路径仅 Auth Edge 派生，Worker 验证已加载会话 cwd 一致。两端用 SHA-256 清单进行三方比较：首次同名异内容是冲突；只有一边相对上次共同基线变化才传输；两边变化则保留两边，不自动选胜者。首次不同名文件双向复制；用户解除冲突使两边内容一致后恢复跟踪。删除仅在存在共同基线且另一边未改时传播，被删除/替换版本保留在各端 .mewclaw-sync/recovery，不自动清理。目录随文件创建；空目录、权限位与符号链接不复制。基线仅内存，重启后重新比较，绝不依据失效基线传播删除。断线/撤销立即停止循环，不重试写请求；取消不是已发生写入的回滚。

Node Provider 在插件内串行化变更，写前校验摘要，将旧版本移入恢复区，再使用排他创建发布新版本；发现外部并发修改明确冲突并保留恢复版本，不覆盖新出现文件。不宣称能隔离恶意本机进程在检查后更换路径的竞态。Shell 与同步串行执行，避免同一 Host 同时主动改文件。

失败表：未授权→LOCAL_*_NOT_AUTHORIZED→本机确认；云端未接入→WORKSPACE_BRIDGE_UNAVAILABLE→管理员启用；版本不符→SYNC_CONFLICT→用户协调两端；超限→SYNC_LIMIT→缩小目录或调整已校验配置；断线/过期/撤销→停止并保留本机模式→重新登录授权；同步响应丢失→停止并重新扫描→不得重放写入。

## 7 安全与信任

网关不得执行工具。电脑目录由本机用户明确授权，不暴露默认整个磁盘。跨账号与跨 Scope 请求拒绝；连接凭证仅本地 Host 内存，不能进模型或浏览器存储。Node 文件能力不是对恶意本机进程的 OS 隔离，发行文档不得夸大。

## 8 测试契约

官方 FileSystem 实例下验证读、列、创建、条件更新；父路径/绝对路径/根外符号链接拒绝；旧版本写入拒绝；超限拒绝；取消和授权撤销拒绝。桥接另需重复请求、断线、重启与跨账号测试；最终用真实桌面目录完成会话纵向验证。

## 9 迁移映射

不迁移已有云端工作区。云端路径和电脑路径保持独立，禁止把电脑路径送进云端 workspace.create 假装已绑定。

## 10 开放问题与验收边界

已实现原生目录授权、桥接协议、工具限制及断线拒绝，并通过离线 HTTP/FileSystem 与真实 Cordis 工具链回归。bind/unbind 使用持久化公开 revision 做条件更新，旧客户端不能撤销新授权；连接 generation 仅在内存。失联连接释放容量但保留本地模式日志。子会话继承父链限制且不得执行工具，父链不可用时拒绝执行。

尚未部署云端配套，完整 Auth Edge 包门禁、真实登录后的桌面界面及云端模型操作本机目录验收待完成。当前只交付开发包，不宣称生产工作区已可用。
