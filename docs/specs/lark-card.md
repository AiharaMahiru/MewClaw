# dsh-lark-card SPEC（卡片渲染）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-card` |
| 位置 | `packages/lark/card` |
| 角色 | Plugin（session 事件 → 飞书卡片的纯函数渲染 + 流式投递策略） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-2, ADR-4 |
| 依赖能力 | `ctx.lark` |
| 提供能力 | 渲染器注册表 + 流式更新缓冲 |

## 1 目的与边界

把运行事件流映射为**最小 markdown 回答卡 / 结构化动作卡 / 失败卡**，并以有序、节流、可恢复的方式投递。

非目标：审批交互卡的**业务状态机**（lark-approval）；卡片载荷类型定义（dsh-lark）；Feishu 之外任何展示。

## 2 服务契约

```ts
interface CardRenderer {  // 注册表：事件类型 → 渲染器
  register(kind: string, renderer: (event: unknown) => CardUpdate | null): Disposable
}
/** 一次渲染结果：目标消息的增量或终态。 */
type CardUpdate =
  | { kind: 'append'; card: CardPayload }          // 追加/替换内容
  | { kind: 'replace'; card: CardPayload }         // 终态替换
  | { kind: 'action'; card: CardPayload }          // 交互卡（转 lark-approval）
```

内置渲染器（M1 全集）：

| 事件 | 输出 |
| --- | --- |
| 运行开始 | 处理卡（processing 文案） |
| assistant 文本增量 | markdown 卡增量（节流合并） |
| 工具开始/完成 | 折叠行（`工具名 · 时长`），无参数/输出全文 |
| 运行完成 | 终态卡（正文 + 收尾统计行） |
| 运行失败（含 EMPTY_RESPONSE/RUN_TIMEOUT 等） | 失败卡（错误码 + 下一步提示） |
| `lark/artifact/created` | 产物卡（文件名 + 下载/转发入口，M1 可仅文本行） |
| `lark/knowledge/citations` | 引用脚注（M3） |

## 3 配置契约

```ts
interface Config {
  /** 增量更新最小间隔（默认 500ms，50ms..60s）。 */
  throttleIntervalMs?: number
  /** 增量合并字节阈值（默认 1 KiB，1..32 KiB，且不得超过 maxCardBytes）。 */
  throttleBytes?: number
  /** 单卡正文字节上限（默认 32 KiB，1..32 KiB；超出截断 + 截断标记）。 */
  maxCardBytes?: number
  /** 终态投递额外重试次数（默认 3，允许 0..5）。 */
  maxRetries?: number
}
```

只有字段缺省时使用默认值；零值、负数、小数、不安全整数和超过上述预算的值在插件
注册前 fail loud，不能把无效配置静默改成默认节流或重试策略。

工具行折叠和失败文案属于 Gateway 的运行编排输入，不是卡片投递器的配置；避免同一
用户可见语义在 Provider 与 Consumer 之间出现无效或双重配置。

## 4 事件契约

消费：运行事件流（经 run-client）；发布：无（渲染结果直接经 `ctx.lark` 投递）。
**展示规则（继承 lark-claw）**：隐藏推理、原始密钥、模型思考内容永不上卡——渲染器白名单化事件字段，非白名单字段丢弃。

## 5 模型可见面

无。

## 6 行为契约

不变量：

- 卡片更新有序：单会话内严格按事件序投递（节流只合并，不重排）；
- 最终态必然替换处理卡：任何路径（完成/失败/中断）都落一次终态更新；
- 渲染函数是纯函数：`(event, config) → CardUpdate | null`，无 IO、无状态（缓冲器在插件层）。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 更新 API 失败（限流/网络） | 退避重试（有界） | 自动；超界转终态卡 |
| 正文超上限 | 截断 + 标记 | 用户可请求 `--full`（M2） |
| 事件白名单外字段 | 丢弃 | 不展示 |
| 投递卡消息被撤 | `LARK_PERMISSION_DENIED` → 停更该卡 | 新消息起新卡 |

## 7 安全与信任

- 事件内容一律视为不可信文本（防注入：卡片渲染按纯文本/markdown 转义规则输出）；
- 白名单外字段不进卡（防隐藏推理/密钥泄漏——继承 lark-claw 展示规则）。
- 命令操作按钮的 callback 只序列化 `actionId`；命令文本、Scope 和授权信息只留在
  commands provider。渲染器不注册、不解析也不授权 action。
- 唯一已注册的 form callback 是 `questionnaire.submit`。`handoff` 和 session-delete 没有
  Provider/Consumer 闭环，渲染器不生成、解析器在 Gateway 路由前拒绝。

## 8 测试契约

- `unit`：每个渲染器的纯函数输出（快照级断言）；
- `unit`：节流合并（间隔/字节阈值）、有序性、终态必然性；
- `unit`：白名单外字段丢弃、截断标记；
- `snapshot`：完整事件流 → 卡片序列（无密钥重放，M1 验收核心）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/streaming-markdown.ts` | 复用（流式 markdown 聚合） |
| `apps/lark-gateway/src/card-update-buffer.ts` | 复用（节流缓冲） |
| `apps/lark-gateway/src/ephemeral-card-scheduler.ts` | **不迁移**（R-20 终态：dsh 无临时确认卡流——session-delete 未迁移、命令回执为持久卡且 M5 验收通过；TTL 删除需新增消息删除 API，无现存使用场景，出现场景时再立项） |
| `packages/lark-adapter/src/markdown-card.ts` | 拆分（载荷类型留 dsh-lark；渲染策略在此） |

行为变化：`UiEvent` 联盟 → session 事件白名单映射；渲染器注册表化（bot 模板可覆盖主题，M4）。M1 实施记录：

1. **工具折叠行配对走 FIFO**：单步内工具串行执行，tool/call 入栈、tool/result 出栈配对时长（无需解析 ToolResultBlock 内部结构）；M2 需要精确 callId 配对时再升级。
2. 增量投递失败的重试只覆盖投递调用（限流/网络）；重试耗尽告警并放弃（终态卡已尽力，不无限重试）。

## 10 开放问题

1. 工具折叠行是否需要"展开参数"入口（交互卡）？（阻塞 M2；倾向 M2 以交互卡提供，M1 仅折叠行）
