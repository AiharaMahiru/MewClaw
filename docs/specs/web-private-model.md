# dsh-lark-web-private-model SPEC（Web 用户私有模型适配器）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-web-private-model`（Plugin，worker） |
| 位置 | `packages/lark/web-private-model/` |
| 角色 | `ctx.llm` 的 Provider 适配器（固定 provider `web-private`） |
| 里程碑 | M7（Web 多用户） |
| 状态 | implemented |
| 依赖能力 | `ctx.llm`、`ctx.credentials`、`ctx.larkScopeIndex`（WebModelRoute 查询） |
| 提供能力 | provider `web-private`（显示名"我的模型"） |

## 1 目的与边界

让普通 Web 用户使用自己在账户中心登记的 OpenAI 兼容私有模型，同时保证：

- baseUrl / API Key **永不写入** Worker 全局 settings、共享 provider 配置或落盘；
- Worker 只在当次 prompt 流内，凭 Auth Edge 签发的短期一次性 capability 换回运行时
  路由（profileId/revision/model/baseUrl/apiKey）；
- 密钥明文只活在单个 async generator 栈帧内，不进入 Scope 索引、日志或事件。

非目标：模型目录枚举（账户中心是唯一目录，`listModels` 恒为空）；服务端额度
（由 billing 能力缝另行计量）；非 OpenAI 兼容协议。

## 2 服务契约

```ts
// Cordis 入口（worker bundle 注入）
export function apply(ctx: Context, config: Config): Promise<void>
//   → ctx.llm.registerAdapter(["web-private"], adapter)

class WebPrivateModelAdapter extends LlmAdapter {
  providerInfo(provider): LlmProviderInfo            // { id: "web-private", name: "我的模型" }
  listModels(provider): Promise<[]>                  // 恒空：目录只在账户中心
  resolveModel(provider, model): LlmResolvedModelInfo
  prepareCall(provider, model): PreparedAdapterCall
  stream(options): AsyncIterable<StreamChunk>        // 见 §6
}
```

`stream` 的错误分类学：`PRIVATE_MODEL_ROUTE_UNAVAILABLE`（无路由/capability/换取失败/
凭据已释放）、`PRIVATE_MODEL_REQUEST_FAILED`（上游调用失败）、`ABORTED`（取消）；
上游原始错误（URL、响应头、网关诊断）一律不外传。

## 3 配置契约

```ts
interface Config {
  /** Auth Edge 内部地址：必须是无凭证 loopback HTTP(S)，否则装载 fail loud。 */
  authBaseUrl: string
  /** Worker 内部凭证引用（env 名）；经 ctx.credentials 解析，缺失 fail loud。 */
  tokenEnv: string
}
```

运行时路由体（`/internal/models/resolve` 响应）经严格 wire 校验：恰好五个字段
（`profileId` UUID / `revision` 正整数 / `model` ≤256 / `baseUrl` ≤2048 / `apiKey`
≤16KiB），且 profileId/revision/model 必须与 capability 引用完全一致。

## 4 事件契约

无自有事件。路由引用经 `larkScopeIndex.webModelRouteForCurrentSelection(sessionId)`
读取 Auth Edge 在 `session.prompt` 授权时绑定的 capability（见 auth SPEC §会话绑定）。

## 5 模型可见面

无新增模型可见输入：适配器只产出官方 `StreamChunk` 流；finish reason 非 stop/
tool-calls 时重写为 `ABORTED` 或 `PRIVATE_MODEL_REQUEST_FAILED` 稳定错误码。

## 6 行为契约

- 每次 `stream` 开始：校验 sessionId → 查 capability 路由引用（`model` 必须等于请求
  模型）→ POST `/internal/models/resolve`（Bearer workerToken，10s 超时，一次性
  capability）→ 严格校验路由体 → `UrlPolicy.assertAllowed(baseUrl)` **重解析** +
  强制 `https:` → 构造临时 `PiAiAdapter`（空凭据存储，API Key 只经闭包供给）→
  透传流；
- `finally` 中清空 `apiKey`/`route` 局部引用；
- provider 断言：任何非 `web-private` 调用抛 `NO_ADAPTER`；
- 模型名 >256 或含控制字符抛 `UNKNOWN_MODEL`。

## 7 安全与信任

- capability：Auth Edge 生成、短期、一次性、绑定 sessionId+rpcId+profileId+revision，
  Worker 侧重放/跨会话使用在 resolve 端点被拒；
- SSRF：baseUrl 保存时由 Auth Edge 校验，真实出站前 Worker 再用 `dsh-lark-url-policy`
  重解析——DNS rebinding 在两点之间无窗口；且强制 HTTPS；
- 密钥面：pi-ai `CredentialStore` 为空实现（delete 永不持久化）；`resolveApiKey`
  仅从闭包读取，换取失败即 `PRIVATE_MODEL_ROUTE_UNAVAILABLE`；
- 错误面：上游细节不外泄，日志与客户端只见稳定错误码。

## 8 测试契约

- `unit`：无当前 prompt capability 时 fail closed 且不请求 Auth Edge；路由换取只携带
  一次性引用；私网 baseUrl 在真实出站前被 UrlPolicy 拒绝；沿用 OpenAI 兼容工具流
  （工具参数恒为 JSON Schema object）。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| （无 lark-claw 对应物，DSH 多用户时代新增） | 新建 |

行为变化：无（新建能力）。

## 10 开放问题

无。
