# dsh-lark-ws SPEC（飞书长连接入口）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-ws` |
| 位置 | `packages/lark/lark-ws` |
| 角色 | Plugin（WebSocket 长连接客户端，发布类型化入口事件） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-3 |
| 依赖能力 | `ctx.credentials`（凭证引用，与 dsh-lark 同 ref——WSClient 需要构造配置而非 ctx.lark 服务 API） |
| 提供能力 | `lark/message/received`、`lark/message/recalled`、`lark/card/action`、`lark/bot/menu` 进程事件 + 连接健康状态 |

## 1 目的与边界

与飞书建立**唯一一条**长连接，把 `im.message.receive_v1`（含 post/图片/文件消息）、`im.message.recalled`、`card.action.trigger`、`application.bot.menu_v6` 转成类型化事件；暴露回调连接健康信号（服务 supervisor 的存活判据）。

非目标：去重、授权、Scope 解析（gateway）；消息内容解析策略（gateway）；重连期间的队列持久化（飞书有官方补发语义，重复由 gateway 去重兜底）。

## 2 服务契约

无新服务。提供：

```ts
/** 进程级事件（声明合并进本包事件表）。 */
interface LarkWsEvents {
  'lark/message/received'(payload: InboundMessage): void   // @mode sync
  'lark/message/recalled'(payload: { messageId: string }): void
  'lark/card/action'(payload: CardActionPayload): void     // 回调载荷未验证
  'lark/bot/menu'(payload: LarkBotMenuEvent): void         // eventId/userId/eventKey，未授权
  'lark/connection'(payload: { state: 'connected' | 'reconnecting' | 'failed' }): void
}
```

`InboundMessage`：`{ messageId, chatId, chatType, senderUserId, messageType, content, receiveAt }`——不含任何授权结论。

## 3 配置契约

```ts
interface Config {
  /** 重连退避下界（默认 1s）与上界（默认 60s）。 */
  reconnectBackoffMs?: { min: number; max: number }
  /** 连接失败即报 `failed` 前的重试窗口（默认 5 分钟，1s..24h）。 */
  failureWindowMs?: number
  /** 健康状态发布间隔（默认 30s，1s..1h，给 supervisor 的心跳源）。 */
  healthPublishIntervalMs?: number
}
```

只有字段缺省时采用默认；零、负数、小数、不安全整数与超范围配置在凭证解析和连接建立前 fail loud。

## 4 事件契约

发布：§2 五个事件。`lark/message/received` 的 `content` 与 `lark/bot/menu` 的 eventKey 都是不信任载荷；本包只做结构解析，不做命令映射或授权。
消费：无。

## 5 模型可见面

无。

## 6 行为契约

不变量：

- 同一时刻至多一条长连接；
- 连接断开后指数退避重连，重连成功后先发布 `connected` 再消费事件；
- 事件发布为 sync 模式且**不阻塞**连接读循环（慢消费者丢给 gateway 队列策略，见 lark-gateway）。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 网络断开 | `lark/connection(reconnecting)`，退避重连 | 自动；窗口内恢复 |
| 持续断连超窗口 | `lark/connection(failed)` | supervisor 视为服务失败（与 lark-claw 语义一致） |
| 收到畸形帧 | 丢弃 + 计一次 `parseFailure`（日志仅计数） | 不重连（偶发帧损坏不视为连接故障） |
| 服务端要求重连 | 按协议帧处理 | 自动 |

## 7 安全与信任

- 所有事件 payload 都是不可信输入；本插件**不做**授权判断；
- 发布前必须以 `parseMessageId`、`parseChatId`、`parseUserId` 校验跨边界 ID；控制字符或超长值按畸形帧丢弃；
- 日志只记 messageId/chatId/事件类型，不记正文。

## 8 测试契约

- `unit`：帧解析（心跳/业务/畸形）、重连退避序列、单连接不变量；
- `unit`：慢消费者不阻塞读循环（背压注入）；
- `unit`：机器人菜单 eventId/userId/eventKey 严格解析并发布，畸形载荷计 parseFailure；
- `e2e`：真实长连接收消息（M1 烟雾，需密钥；无密钥跳过）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/main.ts`（WS 客户端部分） | 重写为插件化 |
| `packages/lark-adapter/src/inbound-message*.ts` | 复用（事件载荷类型化） |
| `packages/lark-adapter/src/bot-menu-event.ts` | 复用（菜单事件归并入入口事件） |

行为变化：网关 main.ts 拆散——WS 生命期独立成插件，进程不再"以连接为生命周期"。M1 实施记录：

1. 重连退避由官方 SDK 的 WSClient 承担（lark-claw 同源）；`reconnectBackoffMs` 不再由本包实现，failureWindowMs（默认 5 分钟）保留为本包判定。
2. 事件表增 `lark/bot/menu`（bot-menu-event 归并）。
3. 撤回事件按 `im.message.recall_v1` 注册（lark-claw 未处理撤回；实际事件名以 M1 e2e 烟雾确认为准）。

## 10 开放问题

1. 飞书官方补发与本地去重窗口的关系：去重 TTL 与平台补发窗口如何对齐？（阻塞 M1 验收；M0 spike 观察真实平台行为）
