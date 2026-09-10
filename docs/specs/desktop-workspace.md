# 桌面本地工作区 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | 桌面本地文件 Consumer 与云端桥接插件 |
| 位置 | apps/desktop/plugins/cloud；待落地云端插件 |
| 角色 | Definition / Provider / Consumer |
| 状态 | implementing |
| 里程碑 | Desktop 1 |
| 关联 ADR | ADR-1、ADR-3、ADR-6 |
| 依赖能力 | 官方 FileSystem、tools、已认证 Scope、桌面原生目录选择 |
| 提供能力 | 受限文件操作与会话绑定的请求传输 |

## 1 目的与边界

云端保持唯一会话与模型执行，桌面只执行已授权目录中的 list/read/write。首版无任意 Shell、子进程、自动目录上传、离线重放或多设备接管。目录授权不等于操作系统沙箱。

## 2 服务契约

本地文件 Consumer 复用官方 FileSystem 的 resolve/contains/stat/readText/listDir/writeText，不重写官方文件持久化。LocalWorkspaceFiles(fs,root,limits) 为一次本地目录授权所有；execute(operation,signal) 返回JSON结果或明确错误；撤销后不得继续处理新请求。operation 为 {action:'list'|'read'|'write',path:string,content?:string,version?:string}，必须为目录相对路径。read 返回不透明版本与正文；write 无 version 只允许创建，给出 version 才允许条件替换。

云端绑定必须携带完整已认证 Scope，模型参数不能指定账号/会话/设备。连接断开或绑定不可恢复时拒绝本地执行，不回退服务器目录。具体桥接 wire、持久化和身份转换须在实施相应模块前补齐。

## 3 配置契约

文件 Consumer limits 显式传 maxBytes、maxEntries，由插件 Config 提供：默认262144字节、500项；范围1024至1048576字节、1至2000项。root 仅来自用户原生目录授权；不从模型参数或浏览器任意路径恢复授权。

## 4 事件契约

文件读取和写入结果通过正常工具执行返回，进入官方工具结果事件。绑定事实必须先持久化再允许使用，尚未定义 wire 的模块不得实施。无额外隐藏模型输入。

## 5 模型可见面

拟提供 desktop_workspace 文件工具，generic 呈现。执行地点、相对路径、文件版本与结果由工具事件记录。绑定本地工作区后必须阻止执行型云端工具误操作服务器。未完成该约束不得上线。

## 6 行为契约

路径同时做相对路径语法验证与官方规范目标 contains 验证；符号链接指向根外拒绝。读前读后版本不同拒绝返回不一致正文；写入必须使用官方 createIfAbsent/replaceIfVersion，不无条件覆盖。目录列表不包含根外目标。读写体积和目录条数有上限，超限明确报错。

## 7 安全与信任

网关不得执行工具。电脑目录由本机用户明确授权，不暴露默认整个磁盘。跨账号与跨 Scope 请求拒绝；连接凭证仅本地 Host 内存，不能进模型或浏览器存储。Node 文件能力不是对恶意本机进程的 OS 隔离，发行文档不得夸大。

## 8 测试契约

官方 FileSystem 实例下验证读、列、创建、条件更新；父路径/绝对路径/根外符号链接拒绝；旧版本写入拒绝；超限拒绝；取消和授权撤销拒绝。桥接另需重复请求、断线、重启与跨账号测试；最终用真实桌面目录完成会话纵向验证。

## 9 迁移映射

不迁移已有云端工作区。云端路径和电脑路径保持独立，禁止把电脑路径送进云端 workspace.create 假装已绑定。

## 10 开放问题

原生目录授权公开能力、云端绑定协议、执行工具限制和断线状态仍待实现；未完成不交付为完整本地工作区。
