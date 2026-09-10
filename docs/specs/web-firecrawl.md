# dsh-web-firecrawl SPEC（web 能力缝 Firecrawl Provider）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-web-firecrawl`（Provider） |
| 位置 | `packages/web/firecrawl/` |
| 角色 | Provider（`ctx.web` 的 search + fetch 双注册） |
| 里程碑 | M4 |
| 状态 | implementing |
| 关联 ADR | ADR-8（能力缝） |
| 依赖能力 | `ctx.credentials`（FIRECRAWL_API_KEY 凭证引用） |
| 提供能力 | web 能力缝的两个 provider 注册（id `firecrawl`）+ `web_map` / `web_crawl` / `web_screenshot` 工具 |

## 1 目的与边界

Firecrawl REST API 的 web 提供方：`/v1/search` → WebSearchProvider；`/v1/scrape` → WebFetchProvider，并在同一 Provider 注册站点 map/crawl/截图工具。取代 lark-claw 的 `@mendable/firecrawl-js` SDK（依赖预算：手写 wire 校验的 REST 客户端，同 SiliconFlow 客户端纪律）。保持 v1 兼容端点；只移植官方字段语义，不迁移到 v2。

非目标：agent/monitor 等 Firecrawl 高级操作；DeepSeek 官方搜索（dsh-base 已挂 web-search-deepseek，可并存——组合层配置决定选谁）。

## 2 服务契约

向 `ctx.web` 注册（dsh-web 能力缝，注册即效果，disposer 随 fiber）：

```ts
id = "firecrawl"
available() = 凭证已装载（不触网）
search({query, maxResults}, signal) → WebSearchResult
fetch({url}, signal) → WebFetchResult
```

wire 映射（手写校验，fail loud）：

- search：`POST {apiUrl}/v1/search` `{query, limit: maxResults ?? 5}`；响应 `data[]` 逐项取 `{url, title?, description?→snippet, publishedDate?→publishedAt}`；`success !== true` → WebError；
- fetch：`POST {apiUrl}/v1/scrape` `{url, formats: ["markdown"]}`；响应 `data.markdown`（内容）+ `data.metadata.statusCode`；content 判定：HTML 检测 → `{kind:'html'}` 否则 `{kind:'text'}`；截断标记来自响应 `data.metadata.truncated?` 或本地长度上限。
- map：`POST {apiUrl}/v1/map` `{url, limit, search?, includeSubdomains?}`；`search` 用于 URL 关键词过滤，`includeSubdomains` 控制子域范围。
- crawl：`POST {apiUrl}/v1/crawl` `{url, limit, scrapeOptions:{formats:["markdown"]}, includePaths?, excludePaths?}`；路径过滤值为正则字符串数组，启动任务后轮询 `GET /v1/crawl/:id`。
- screenshot：`POST {apiUrl}/v1/scrape` `{url, formats:["screenshot"]}`；成功响应读取 `data.screenshot` 字符串 URL。截图 URL 是外部短期产物，按 Firecrawl 语义约 24 小时有效，不落本地、不当作永久附件。

## 3 配置契约

```ts
interface Config {
  /** Firecrawl API Key 凭证引用（env 变量名；缺失 fail loud at load）。 */
  apiKeyEnv: string
  /** 可选备用 API key 列表的凭证引用；空值视为未启用。 */
  apiKeyFallbacksEnv?: string
  /** API base URL（默认 https://api.firecrawl.dev；HTTP(S)，不得含嵌入凭证）。 */
  apiUrl?: string
  /** 请求超时（默认 60s，范围 1s..5min）；429 重试 2 次退避。 */
  timeoutMs?: number
  /** 是否注册 web_map / web_crawl / web_screenshot 工具（默认 true）。 */
  enabledTools?: boolean
}
```

URL 与超时在凭证解析和 Provider 注册前校验。只有字段缺省时取默认；显式空 URL、非
HTTP(S) URL、嵌入用户信息、零值、小数、不安全值和超范围超时均 fail loud。

## 4 事件契约

无（web 缝执行面；错误经 WebError 给 dsh-tool-web 的结构化错误）。

## 5 模型可见面

经 dsh-tool-web 的 `web_search` / `web_fetch`（dsh-base 已挂工具行；组合层把 web 缝的 searchProvider/fetchProvider 指到 firecrawl），以及本包直接注册的 `web_map` / `web_crawl` / `web_screenshot`。后者没有 dsh-web 对应能力缝，注册生命周期仍由本插件的 Cordis fiber 管理。

## 6 行为契约

- 密钥纪律：key 只经凭证引用；错误信息脱敏（replaceAll(key)）；不落日志；
- 重试仅 429（退避 1s×2^n，2 次）；其余状态即失败；AbortSignal 透传；
- 成本纪律：单页 `web_fetch` / `web_screenshot` 优先；只有需要站点级发现或比较时才使用 map/crawl；crawl 页数与 `limit` 按任务所需设置，避免无界 credits 消耗。
- available() 不做网络调用；凭证缺失 → 装载期 fail loud（组合层缺失该 env 时 worker 拒绝启动——web 是显式能力，不允许半可用）。

## 7 安全与信任

- 检索/抓取结果是不可信证据（dsh-tool-web 层已标记；本 Provider 只做无损映射）；
- URL 由模型/工具面给入：scrape 只按 Firecrawl 云执行，本进程不直接出网（除 API 调用外无 SSRF 面——Firecrawl 云是唯一出网点）；
- 响应体长度上限（1 MiB）防超大内容。

## 8 测试契约

- `unit`：wire 解析（search/scrape 形状、success=false 报错、缺字段容错）、429 重试、密钥脱敏、available 语义、超长响应截断标记；
- `unit`：map/crawl 的过滤与终态、截图 URL 解析、取消信号与轮询延迟均用 mock/fake timers 验证，不等待真实 3 秒；备用 key 环境值为空时仍只使用主 key；
- `e2e`（有密钥才跑，skipIf）：真 search + scrape 一条链路。

## 8a 多 key 轮换与扩展工具（升级 SPEC）

### 多 key 轮换（额度分摊）

- Config 增 `apiKeyFallbacksEnv`（env 变量名，值 = 逗号分隔的备用 API key 字符串；配置名存在但环境值为空时同样视为未启用）。只有 `apiKeyEnv` 缺失才在装载期 fail loud。
- 轮换策略：**逐请求轮转（round-robin）分摊额度**；请求失败且状态码为 401/402/429（配额/认证类）时立即换下一把 key 重试（不占用退避延迟）；其余错误维持既有退避重试（同 key）。全 key 耗尽才向调用方报错。
- 错误脱敏覆盖所有 key。

### 扩展工具（crawl / map / screenshot）

Firecrawl 包持有 wire 客户端，顺带注册三个模型工具（`enabledTools` 缺省 true）：

- `web_crawl`：`{ url, maxPages?, includePaths?, excludePaths? }` → 站点内逐页抓取（默认上限 20 页，硬上限 50），返回逐页 `{url, markdown 前 2000 字符}` 列表；`includePaths` / `excludePaths` 为正则数组，`exec.signal` 透传取消。任务状态 `failed` / `cancelled` 立即转为错误，不继续轮询。
- `web_map`：`{ url, limit?, search?, includeSubdomains? }` → 站点 URL 清单（默认上限 100，硬上限 500）；`search` 与子域开关原样透传。
- `web_screenshot`：`{ url }` → 单页截图 URL；只返回 URL 与“约 24 小时有效”提示，不下载截图。

search/scrape 仍经 ctx.web 注册表（dsh-tool-web 消费）；crawl/map 无框架缝位，由本包直接注册工具并在系统提示声明——SPEC 记录该取舍（wire 协议单一归属优先于包角色纯粹性）。

## 9 迁移映射

| lark-claw 来源 | 处置 |
| --- | --- |
| `skills/web/src/env.ts`（@mendable/firecrawl-js + FIRECRAWL_API_KEY） | 重写为手写 REST 客户端（去 SDK 依赖） |
| `skills/web` 其余（crawl/map/agent CLI） | 不迁移（技能域 M4 后半评估） |

行为变化：SDK 换 REST（能力面扩展为 search+scrape+map/crawl/screenshot 工具，web 缝仍只承载 search/fetch）；凭证从 env 直读改为凭证引用。

## 10 web × cron 用法范式

页面监控不需要额外 changeTracking 计费：用 `cron_schedule` 每日触发一次 `web_fetch` 或 `web_crawl`，需要最新结果时在任务提示中要求强制刷新（后续 P2 再接 `maxAge: 0` 配置）。把上次摘要与本次摘要交给模型比较，只有发现变化才通知用户；crawl 页数保持最小并在任务描述中记录成本预算。

## 11 开放问题

1. `changeTracking` / `maxAge`、结构化 `json` / `product`、batch/webhook 与 actions → 后续专项评审；本 P1 不实现。
