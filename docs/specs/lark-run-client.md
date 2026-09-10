# dsh-lark-run-client SPEC（桥接客户端）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-run-client` |
| 位置 | `packages/lark/run-client` |
| 角色 | Consumer（worker 运行 API 的网关侧客户端） |
| 里程碑 | M1 |
| 状态 | implementing（M1 实施中；实现与测试已落地） |
| 关联 ADR | ADR-4 |
| 依赖能力 | `ctx.credentials` |
| 提供能力 | 提交运行、流式消费 NDJSON、控制端点调用 |

## 1 目的与边界

网关侧对 `dsh-lark-run` 的唯一客户端：提交 `RunRequest`、把 NDJSON 流转成类型化事件（含心跳容忍）、调用 cancel / interaction / session-overview / cron 端点。

非目标：重试提交的**业务决策**（是否重发归 gateway）；事件→卡片渲染（lark-card）。

## 2 服务契约

```ts
interface LarkRunClient {  // 服务键 ctx.larkRunClient（本仓库自有服务）
  /** 提交运行；返回事件流（async iterable of validated events + 终止行）。 */
  submit(request: RunRequest, signal?: AbortSignal): Promise<RunEventStream>
  /** 取消运行（幂等；运行不存在/已结束 = 成功）。 */
  cancel(runId: RunId): Promise<void>
  /** 送达交互问卷答案（幂等；待办不存在 = 成功）。 */
  resolveInteraction(
    scope: Scope,
    interactionId: InteractionId,
    answer: { selected: string[]; custom?: string },
  ): Promise<void>
  /** 完整 Scope + generation 对应的只读持久化会话投影。 */
  sessionOverview(input: SessionOverviewRequest): Promise<SessionOverview>
  /** 当前目标与已 claim 会话目录；每次调用都由 Worker 重新授权。 */
  sessionCurrent(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>
  sessionList(input: SessionDirectoryRequest): Promise<SessionDirectoryList>
  sessionClaim(input: SessionClaimRequest): Promise<SessionDirectoryCurrent>
  sessionUse(input: SessionUseRequest): Promise<SessionDirectoryCurrent>
  sessionNew(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>
  sessionUnlink(input: SessionDirectoryRequest): Promise<SessionDirectoryCurrent>
  /** 读取经 Worker 重新验证的图片 artifact；不接受路径或目录。 */
  readArtifact(input: ArtifactReadRequest): Promise<ArtifactImage>
  /** cron 控制与投递。 */
  cronControl(command: CronControlCommand): Promise<unknown>
  claimCronDeliveries(input: CronDeliveryClaimRequest): Promise<CronDelivery[]>
  ackCronDelivery(input: CronDeliveryAckRequest): Promise<boolean>
}
```

`RunEventStream`：`RunStreamItem | RunStreamDone`（contracts）的 async 迭代；迭代中周期 yield 的心跳空行由客户端吞掉（对上层透明）；终止行 `RunStreamDone` 是最后一行。EOF 前没有终止行视为 `STREAM_BROKEN`；最后一条合法行可省略换行符。

## 3 配置契约

```ts
interface Config {
  /** worker 基址。 */
  baseURL: string
  /** worker 凭证引用名；与 lark-run 一致。 */
  tokenEnv?: string
  /** 请求超时（默认 30s，1s..5min；仅覆盖连接与首字节；流不设总时长）。 */
  connectTimeoutMs?: number
  /** 心跳容忍（默认 45s，1s..5min）：超过该时长无任何帧即视为断流。 */
  heartbeatToleranceMs?: number
  /** 单事件字节上限（默认 64 KiB，1 KiB..1 MiB，防御超大帧）。 */
  maxEventBytes?: number
  /** 非流式 Worker 响应上限（JSON 与图片；默认/最大 32 MiB，1 KiB..32 MiB）。 */
  maxResponseBytes?: number
}
```

配置边界在凭证解析前固定；只有字段缺省才取默认，显式零值、负数、小数、不安全或超范围值直接阻止客户端注册。非流式 JSON 与图片响应都会同时核对 `content-length` 和实际流读取字节，拒绝后不进入 Gateway 解析或日志。

## 4 事件契约

发布：`lark/run/stream/error`（断流、schema 失败；仅 runId + 错误码）。
消费：无（被 gateway 消费其返回值，不广播）。

## 5 模型可见面

无。

## 6 行为契约

不变量：

- 每个事件先验 envelope（runId + 完整 Scope 与提交一致）再 yield；
- 心跳空行对上层透明；容忍窗口内无业务帧不算断流；
- 提交只发一次（重试决策在 gateway）；连接失败不自动重发（幂等风险）。
- 图片读取只发送完整 `ArtifactReadRequest`，并复核 Worker 回应的安全 raster MIME、实际字节数和 SHA-256；没有路径、目录或任意文件读取面。
- 会话目录调用只发送闭合 DTO；客户端逐字段验证 current/list 响应，不接受绝对 cwd、未知字段或畸形时间戳。

失败模式表：

| 触发 | 观测结果 | 恢复 |
| --- | --- | --- |
| 连接失败 / 超时 | `CONNECT_FAILED`（gateway 出失败卡） | 用户重发 |
| 流中途断（非最终事件） | `STREAM_BROKEN` | gateway 替换为中断卡 |
| 事件 schema 不符 / 非法 UTF-8 | 丢弃该事件 + `STREAM_SCHEMA_ERROR` 计数 | 不影响其它事件 |
| 心跳超时 | `STREAM_BROKEN`（同断流） | 同上 |
| 4xx/5xx | 按状态码映射错误码 | gateway 决策 |
| 图片 MIME、长度或 SHA-256 不符 | `RESPONSE_SCHEMA_ERROR` | Gateway 显示单条交付失败提示，不失败整个 run |
| claim 过期/复用或 session 不再可用 | 稳定 404/409 映射 | 命令面提示重新分享或 `/session new` |
| 会话目录响应含未知字段或超限列表 | `RESPONSE_SCHEMA_ERROR` | 拒绝渲染，记录脱敏错误码 |

## 7 安全与信任

- NDJSON 是不信任输入：逐行解析、逐事件 schema 校验、按 UTF-8 实际字节计算的帧上限（无换行半帧同样在缓冲阶段受限）；解码必须使用 fatal UTF-8，非法字节在 JSON 解析前以 `STREAM_SCHEMA_ERROR` 拒绝；
- artifact response 是不信任二进制：仅接受固定 raster `content-type`，声明/实际字节受同一预算保护，读取后重新计算 SHA-256；
- sessionId 是资源标识，不是所有权证据；run-client 不缓存授权结果，也不绕过 Worker 的完整 Scope + generation 校验；
- 日志只记 runId/错误码，不记事件内容。

## 8 测试契约

- `unit`：NDJSON 解析（心跳混排/半帧/超大帧/畸形 JSON/非法 UTF-8）、envelope 不匹配拒绝、断流判定；
- `unit`：cancel 幂等、连接失败不重发；
- `security`：artifact read 请求携带完整 Scope 与品牌化 ID，拒绝错误 content-type、超限/截断响应和摘要/字节不符；
- `security`：会话目录请求携带完整 Scope + generation，响应拒绝未知字段、超限列表、畸形 sessionId/时间戳与 cwd 泄漏；
- `snapshot`：固定 NDJSON 样本 → 事件序列一致。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `apps/lark-gateway/src/worker-client.ts` | 复用（提交/取消语义） |
| `apps/lark-gateway/src/ndjson.ts` | 复用（帧解析、心跳） |
| `apps/lark-gateway/src/worker-cron-control.ts` / `todo-worker-client.ts` | M2 复用（cron）；todo 删除 |
| `apps/lark-gateway/src/worker-api.ts`（网关侧） | 删除（被本包取代） |

## 10 开放问题

无（阻塞项已由 lark-run SPEC 承载）。
