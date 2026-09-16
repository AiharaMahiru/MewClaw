# dsh-lark-deepseek-routing SPEC（DeepSeek 逻辑↔wire 模型路由）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-deepseek-routing`（Plugin，worker） |
| 位置 | `packages/llm/deepseek-routing/` |
| 角色 | `ctx.llm` 的 Provider 适配器（`deepseek-official`）+ settings 节 `llm-deepseek` |
| 里程碑 | M7（模型目录收敛） |
| 状态 | implemented |
| 依赖能力 | `ctx.llm`、`ctx.credentials`/`launchEnvironment`（API key 引用）、`ctx.settings`、官方 `DeepSeekAdapter` |
| 提供能力 | provider `deepseek-official`（显示名 "DeepSeek"） |

## 1 目的与边界

包装官方 `DeepSeekAdapter`，只处理**逻辑/wire 模型 ID 路由与目录收敛**：

- 对模型目录只公开允许的 DeepSeek 模型（当前仅 `deepseek-v4.1-flash`）；
- 逻辑 ID（`deepseek-v4.1-flash`）在出站时映射为 wire ID
  （`deepseek/deepseek-v4.1-flash`）；
- 隐藏/禁用模型在任何网络请求之前拒绝（`MODEL_DISABLED`）。

非目标：传输、图片附件、Files API、thinking 扩展、重试策略——全部委托官方
Adapter 原样透传；不新增凭证面（沿用 `apiKeyEnv` 凭证引用）。

## 2 服务契约

```ts
export function apply(ctx: Context, config: Config): void
//   → ctx.llm.registerConfigurableProviders([{ provider, settingsNs: "llm-deepseek" }])
//   → ctx.llm.registerAdapter(["deepseek-official"], RoutedDeepSeekAdapter(official, snapshot))
//   → settings.installSection("llm-deepseek")（setSource 热更新 + onChange 重注册）

class RoutedDeepSeekAdapter extends LlmAdapter {
  // 透传：providerInfo/providerRetryPolicy/imageRequestPricing
  // 收敛：listModels 过滤为 visibleModels
  // 路由：resolveModel/prepareCall/stream 先 assertEnabled，再把 model 映射为 wire ID
}
```

快照语义：`snapshot()` 缓存最近一次合法 `RoutingSnapshot`（connection/aliases/
disabled/visibleModels）；settings 给出非法配置时保留 last-good 并记日志，
不击穿在途调用。

## 3 配置契约

```ts
interface Config extends OfficialDeepSeekConfig {
  /** 逻辑 ID → wire ID。缺省 { "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash" }；
      settings 空字典不丢必需映射，显式项覆盖同名键。 */
  modelAliases?: Record<string, string>
  /** 禁用模型（逻辑或 wire ID 命中即拒）。缺省 ["deepseek-v4-flash-vision-exp"]。 */
  disabledModels?: string[]
}
```

校验：别名两端任一端命中 disabled → 装载 fail loud；alias 的 wire 目标不在目录
可见集时自动生成一条继承条目；`apiKeyEnv` 仍是凭证引用，解析不到 key 抛
`MISSING_CREDENTIAL`（`assertUsableApiKey` 复用官方校验）。

重试策略：worker patch 给本适配器配置 `retryPolicy`（normal mode），在官方默认
`EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT` 上补 `STREAM_CLOSED`——上游
relay 偶发不发 `[DONE]` 直接断流是独立 code，默认集合不含它则整轮即败（R49 后
实发）。`dsh-llm-retry` 随 dsh-base 挂载，在 agent loop 步骤边界持久化重试；
pi-ai profile 的同名策略在 `settings.production.yaml` 逐 provider 配置。

## 4 事件契约

无自有事件。

## 5 模型可见面

- 目录面：`listModels` 只返回 `visibleModels`（当前唯一公开项
  `deepseek-v4.1-flash`）；别名 wire 目标若不在可见集则补一条同配置继承条目；
- wire 面：`resolveModel`/`prepareCall`/`stream` 的请求模型经 `aliases` 映射后
  出站，响应中的模型身份仍是逻辑 ID（`prepareCall` 返回的 `model` 为逻辑信息）。

## 6 行为契约

| 输入 | 结果 |
| --- | --- |
| 请求禁用模型（逻辑或 wire 命中 disabled） | `LlmError MODEL_DISABLED`，在任何网络请求之前 |
| `modelAliases` 提供空/部分字典 | 与 `DEFAULT_ALIASES` 合并，必需映射保留 |
| settings 更新为重试策略不同值 | `registration.replace` 重注册 adapter |
| settings 更新为非法值 | 保留 last-good 快照，错误日志，不炸在途流 |
| 别名端点命中 disabled | 装载 fail loud |

## 7 安全与信任

- 模型面收敛是 fail-closed：`assertEnabled` 在每次调用前与 wire 映射后各查一次
  disabled；
- API key 只经凭证引用/launch environment 解析，不写入日志；
- 不重写官方适配器的任何传输/鉴权行为，避免私有分叉。

## 8 测试契约

- `unit`：默认把 V4.1 Flash 映射为 `deepseek/deepseek-v4.1-flash` wire ID；空别名
  字典保留必需映射；目录只公开 V4.1 Flash；请求序列化用 wire model 而返回身份仍
  为逻辑 ID；直接指定被隐藏模型在网络请求前拒绝。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| （无 lark-claw 对应物，模型目录收敛需求随 Web 多用户引入） | 新建，薄包装官方 Adapter |

行为变化：无（新增路由层；官方行为透传）。

## 10 开放问题

无。
