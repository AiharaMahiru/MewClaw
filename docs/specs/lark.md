# dsh-lark SPEC（飞书客户端能力）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark` |
| 位置 | `packages/lark/lark` |
| 角色 | Service Definition + REST Provider（一个包两个职责：定义稳定面 + 提供 HTTP 实现） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-3 |
| 依赖能力 | `ctx.credentials`（凭证引用） |
| 提供能力 | `ctx.lark` |

## 1 目的与边界

飞书 OpenAPI 的**唯一封装面**：应用访问令牌、消息收发、按用户建立 P2P 会话、卡片更新、资源下载、群成员读取。网关域插件只依赖 `ctx.lark`，不直接构造 HTTP 请求。

非目标：WebSocket 长连接（归 `dsh-lark-ws`）；卡片**渲染策略**（归 `dsh-lark-card`，本包只提供卡片载荷类型）；领域编排与授权决策（归 gateway/approval）。

## 2 服务契约

```ts
interface LarkApi {  // ctx.lark
  /** 获取有效访问令牌（缓存 + 提前续期 + 单飞刷新）。 */
  getToken(): Promise<TenantAccessToken>
  /** 发送文本、markdown 卡片或已上传图片；返回 message_id（以平台返回为准，勿自造）。 */
  sendMessage(chatId: ChatId, content: MessageContent): Promise<MessageId>
  /** 按用户 open_id 发送消息；只信任平台响应中校验后的真实 P2P chat_id。 */
  sendMessageToUser(userId: UserId, content: MessageContent): Promise<{ messageId: MessageId; chatId: ChatId }>
  /** 上传已由 Worker 验证的图片字节；返回通过格式校验的 image_key。 */
  uploadImage(bytes: Uint8Array): Promise<ImageKey>
  /** 更新指定消息（卡片流转用）。 */
  updateMessage(messageId: MessageId, content: MessageContent): Promise<void>
  /** 下载消息资源（文件/图片），流式返回；认证后才行。 */
  downloadResource(messageId: MessageId, fileKey: string): Promise<ReadableStream<Uint8Array>>
  /** 群成员列表（受网关 allowlist 策略约束，见 lark-members SPEC）。 */
  getChatMembers(chatId: ChatId): Promise<ChatMember[]>
}
```

前置条件：调用方已通过授权检查（`ctx.lark` 本身不做 allowlist 判断——那是 gateway 的职责；本服务只保证"调用即认证"）。
失败方式：全部 typed error（§6 失败模式表），不抛未分类异常。

卡片载荷类型（纯数据，无渲染逻辑）：`MarkdownCardPayload`、`InteractionCardPayload`（按钮/回调值 schema）、`CardActionPayload`（回调解析 + 字段校验）。`MessageContent` 另含 `{ kind: "image", imageKey: ImageKey }`，只能由本服务 `uploadImage()` 返回的品牌化 image key 构造。命令按钮的 wire value 只含 UUID 形态的 `actionId`；唯一已注册的 form callback 是 `questionnaire.submit`。命令语义、Scope 与授权状态不进入卡片 payload；没有 Consumer 的 handoff 或 session-delete 表单在解析边界拒绝。

## 3 配置契约

```ts
interface Config {
  /** 应用 ID 凭证引用（env 变量名）；缺失 fail loud at load。 */
  appIdEnv: string
  /** 应用密钥凭证引用；缺失 fail loud at load。 */
  appSecretEnv: string
  /** 官方 SDK domain；缺省使用 SDK 默认域名。 */
  baseURL?: string
  /** 资源下载大小上限（默认 50 MiB，范围 1 byte..100 MiB）。 */
  maxResourceBytes?: number
}
```

密钥值永不进 Config——只有引用名。`maxResourceBytes` 只有字段缺省时才取默认；显式
零值、负数、小数、不安全值或超过 100 MiB 均在凭证解析前 fail loud。当前 M1 不提供
`tokenRefreshSkewMs`、`timeoutMs` 或 `retry` 配置面，避免声明无法执行的 tunable。日志不得打印令牌、messageId 之外的用户内容。

## 4 事件契约

发布：无。
消费：无（被动服务）。

## 5 模型可见面

无（网关宿主面服务，不进模型上下文）。

## 6 行为契约

不变量：

- 令牌缓存是单飞（concurrent refresh 合并为一次）；
- 令牌过期后的首次请求：刷新一次 → 重试一次 → 仍失败则 `LARK_TOKEN_FAILED`；绝不无限重试。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 凭证缺失/无效 | load 或首请求即 `LARK_AUTH_FAILED` | 修复凭证引用后重启 |
| 令牌过期（并发请求） | 单飞刷新；全部请求等待同一刷新结果 | 自动 |
| 限流（平台 53001 类） | `LARK_RATE_LIMITED`（含 retry-after 提示） | 调用方（card 节流器）退避 |
| 消息被撤/无权限 | `LARK_PERMISSION_DENIED` | 网关转为用户可见失败卡 |
| 网络中断 | `LARK_NETWORK` | 重试策略仅幂等路径 |
| 按用户发送返回缺失/非法 message_id 或 chat_id | `LARK_API_FAILED` | 拒绝构造 P2P Scope，不猜测 `open_id == chat_id` |
| 下载资源校验失败（大小/哈希） | `LARK_RESOURCE_INVALID` | 拒绝入库（uploads SPEC） |
| 图片上传输入为空/超预算、平台返回无效 image_key 或 message_id | `LARK_RESOURCE_INVALID` / `LARK_API_FAILED` | Gateway 保留 run 成功，并在处理卡提示图片未交付 |

## 7 安全与信任

- 令牌只存在于进程内存，永不落日志/事件/持久化；
- OpenAPI 返回的 `message_id`、P2P `chat_id` 与 `member_id` 在进入内部类型前必须通过 contracts 的 `parse*Id` 校验；无效消息/P2P 会话 ID 失败，成员条目跳过；
- 图片 `image_key` 是 SDK 边界返回的外部 ID，必须无控制字符、非空且在长度预算内后才品牌化；图片字节在上传前须为非空，且不超过 `maxResourceBytes` 与飞书消息图片固定 10 MiB 上限中的较小值；
- `downloadResource` 返回的字节是不信输入：大小上限、流截断、调用方再次摘要校验；
- 卡片回调载荷（`CardActionPayload`）是不信任输入：回调值 schema 校验在 gateway/approval 重做，本包只负责解析。

## 8 测试契约

- `unit`：令牌缓存命中/过期/单飞刷新（并发下只发一次请求）；
- `unit`：全部失败模式（mock transport 注入限流/断网/无效令牌）；
- `unit`：卡片载荷类型解析拒绝用例（缺字段、非法回调值）；
- `unit`：图片上传使用 `im.v1.image.create`，拒绝无效 image_key，并由 `message.create(msg_type: "image")` 发送品牌化 key；
- `unit`：按 `open_id` 发送使用独立 `receive_id_type`，同时校验返回的 message_id/chat_id；任一非法均 fail closed；
- `e2e`（M1 烟雾）：真实 `im.message.receive_v1` → 回复（需密钥，无密钥跳过）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `packages/lark-adapter/src/lark-sdk.ts` | 重写（令牌管理、错误分类学、类型化） |
| `packages/lark-adapter/src/inbound-message*.ts` | 移入 `dsh-lark-ws`（入口事件） |
| `packages/lark-adapter/src/lark-file.ts` / `lark-resource.ts` | 复用（下载/资源校验逻辑） |
| `packages/lark-adapter/src/interaction-card.ts` | 复用（载荷模型；渲染策略移 lark-card） |
| `packages/lark-adapter/src/markdown-card.ts` | 载荷类型保留；渲染策略移 lark-card |
| `packages/lark-adapter/src/bot-menu-event.ts` | 移入 `dsh-lark-ws` |

行为变化：Pi 时代的 SDK 对象跨边界传播删除；`ctx.lark` 是唯一出口。M1 实施记录（与 lark-claw 的差异）：

1. **令牌缓存/单飞**委托官方 node-sdk 的 Client（lark-claw 同源语义）；`getToken()` 走 `auth.v3.tenantAccessToken.internal`，仅作诊断/展示。
2. **卡片回调的命令词汇白名单校验**从解析层移至 dsh-lark-commands 注册表——本包 `parseCardAction` 只做结构校验（非空、≤256、UUID），词汇守卫归命令域（职责就近）。
3. 错误分类按平台错误码表映射为 `LARK_*` typed error（lark-claw 的裸 Error 升级）。
4. **图片交付**：Worker 仍拥有 artifact 文件读取，Gateway 仅取得已验证字节并调用 `ctx.lark.uploadImage()`；上传后以标准 `image` 消息发送，不将 `image_key` 落入 session 事件或日志。
5. **菜单 P2P 解析**：`sendMessageToUser()` 复用飞书 message.create 的 `open_id` 接收面，并只返回平台响应中品牌化后的 messageId/chatId；该方法不做授权，调用前仍由 Gateway allowlist 裁决。

## 10 开放问题

无。账号机器人采用每App独立Cordis根及独立 `ctx.lark`/WS；不把多个凭证塞进同一个客户端，见 [feishu-bots.md](feishu-bots.md)。
