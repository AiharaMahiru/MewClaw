# 账号飞书自建应用 SPEC

| 元数据 | 值 |
| --- | --- |
| 包 | dsh-lark-auth / auth-edge / gateway / web-auth |
| 角色 | Definition（BotStore/Service）、Provider（Pg/内存及独立Cordis实例）、Consumer（Edge/UI） |
| 状态 | implementing |
| 依赖能力 | credentials、现有Lark/WS/card/commands/gateway |

## 1 目的与边界
每Web账号保存一个自建应用并管理启停。官方配置目录没有账号机器人管理能力；复用自有现成插件，不修改官方框架、不新增外部依赖。所有机器人统一由账号页管理；默认组合不再启动部署级机器人，也不再保留部署App ID。账号间App ID唯一约束仍生效。
## 2 服务契约
`FeishuBotStore.get(userId):Promise<BotRecord|undefined>`、`list():Promise<BotRecord[]>`、`save(record,expectedRevision):Promise<boolean>`。读写按服务端owner派生；userId主键、appId唯一；乐观版本冲突409。公共投影不含secret或密文。
`FeishuBotService`提供read/save/test/setEnabled/runtime/status；保存默认停用，校验成功不代表消息权限或WS已连接。每账号独立根Context和事件总线，WS最后挂载，dispose停止连接。失败隔离到该实例。
## 3 配置契约
复用现有用户凭证AES主密钥，以独立feishu binding命名空间加密App Secret；主密钥不出Auth。gateway fleet配置authEndpoint（loopback）、tokenEnv（凭证引用）、pollIntervalMs（默认5000，1000..60000）、stateDir/uploadsRoot（必填）。运行配置不进入Cordis可持久化config；内存credentials provider按引用解析。
## 4 事件契约
`retryDelayMs` 默认30000，范围1000..300000；failed实例按此间隔先停后重建。`maxResourceBytes`默认50MiB，范围1..100MiB，沿用Lark资源预算。运行清单只来自Auth的账号配置，不消费部署级LARK_APP_ID/Secret。
每个独立根内复用lark/*事件，不向部署根转发消息。状态connected/reconnecting/failed来自WS生命周期；心跳过期显示unknown，不把校验令牌冒充已连接。
宿主通过公开Cordis logger exporter输出本插件的固定同步/失联文案，首次、数量变化和恢复时只记录启用实例数量，无账号ID或凭据；exporter随插件dispose移除。空清单同步成功属于健康状态，不要求有WS连接。
## 5 模型可见面
无新增工具或提示词；消息通过既有gateway→worker→session落盘链路。
## 6 行为契约
保存配置使enabled=false，启用必须先校验官方token与bot信息；名单必填。更改版本先停止旧实例再启新实例。只有最新有效配置运行；控制面失联时停止个人实例，避免停用指令丢失；恢复后自动重建。
| 失败 | 结果 | 恢复 |
| --- | --- | --- |
| 无会话/CSRF | 401/403 | 重新登录 |
| 错误凭证/上游超时 | 脱敏错误，不启用 | 修改应用或重试 |
| 保存并发/重复App | 409，不覆盖 | 刷新 |
| owner停用/配置停用 | 不再提供运行配置 | 重新启用 |
| WS失败/控制面失联 | failed/unknown，停止或等待重试 | 恢复网络 |
## 7 安全与信任
前端不能指定owner；所有写操作CSRF。域名仅官方feishu.cn/larksuite.com，不允许任意URL/重定向。内部端点仅loopback且bearer，不接受Cookie替代；正文不得记录。每个实例使用owner与配置ID独立Scope、state目录。个人机器人不使用全局Open ID登录配对，避免不同App的身份混用。
## 8 测试契约
unit/security：加密绑定、保存并发、跨账号投影、App重复、CSRF、内部鉴权、断开与独立实例。snapshot：无密钥UI。e2e：模拟飞书及真实浏览器；真实飞书消息收发需已发布且有权限的应用，不具备时报告未覆盖，不虚报。
## 9 迁移映射
没有旧数据迁移。新增auth/005配置表，旧表不改；回退旧代码可忽略新表，禁止恢复旧数据库覆盖新增数据。账户身份页移为独立设置；新增机器人表单替代仅部署说明。2026-09-10移除默认部署连接，不自动迁移旧凭据或历史Scope；空账号配置时零机器人连接，旧应用需用户在账号页保存并启用。
## 10 开放问题
真实外部飞书应用发布/权限与收发验收取决于应用控制台设置；不自动更改飞书开放平台权限。
