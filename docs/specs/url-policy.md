# dsh-lark-url-policy SPEC（公网 URL SSRF 防护）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-url-policy`（共享库，非插件） |
| 位置 | `packages/lark/url-policy/` |
| 角色 | 复用安全原语：Auth Edge 用户私有模型 baseUrl 校验、`dsh-lark-web-private-model` 出站前重解析、`apps/browser` Chromium egress 代理 |
| 里程碑 | M7（随 Web 多用户与浏览器面落地） |
| 状态 | implemented |
| 依赖能力 | 无（`node:dns`/`node:net`，DNS 解析器可注入） |

## 1 目的与边界

为"用户可配置的出站 URL"提供统一的 fail-closed 校验：只允许解析到公网地址的
`http:`/`https:` URL。它是纯库不是 Cordis 插件，不注册任何 `ctx` 服务。

非目标：出站请求的鉴权/配额（由调用方各自负责）；HTML/内容级安全（只管 URL 与
解析结果）；浏览器导航的内容安全策略（由 browser 应用层叠加）。

## 2 服务契约

```ts
class UrlPolicy {
  constructor(resolveDns?: DnsResolver)                    // 默认系统 DNS
  /** 校验通过返回规范化 URL；拒绝抛 UrlPolicyError。 */
  assertAllowed(input: string, topLevel: boolean): Promise<URL>
  /** 同上，同时返回解析得到的地址集（供调用方复用同一解析结果建立连接）。 */
  resolveAllowed(input: string, topLevel: boolean): Promise<ResolvedUrl>
}
function blockedAddress(input: string): boolean            // 单地址判定
function guardedLookup(resolveDns?: DnsResolver)           // 连接期 lookup（undici/net 兼容）
class UrlPolicyError extends Error                         // 公开错误，message 固定脱敏
```

调用契约：**保存时与每次真实出站前各调一次**。后者重新 DNS 解析，配置保存后发生
DNS rebinding 把域名指回私网也会在连接前被拒；browser 代理更进一步复用
`resolveAllowed` 返回的地址直连，消除校验与连接之间的二次解析窗口。

走 `fetch` 的调用方（无法复用 `resolveAllowed` 地址直连）必须用
`UrlPolicy.createGuardedDispatcher()` 产出的 dispatcher：`fetch(url, { dispatcher })`
把策略判定装进连接 lookup——连接所用解析即被检查解析，且每次新建 TCP 连接重新过
判定；任一地址命中 `blockedAddress` 即整体拒绝，lookup 失败按 `ENOTFOUND` 上抛。
域名在 assertAllowed 与 fetch 之间的二次解析窗口由此关闭。

## 3 配置契约

无可调字段。DNS 解析器仅作构造注入（测试 fake resolver），不是部署配置。

## 4 事件契约

无（库不发布事件）。

## 5 模型可见面

无（不进入模型请求）。

## 6 行为契约

| 输入 | 结果 |
| --- | --- |
| `http:`/`https:` 且解析全为公网地址 | 放行 |
| `data:`/`blob:` 且 `topLevel=false` | 放行（仅子资源） |
| 其他协议、`file:`、凭证 userinfo、空主机 | `UrlPolicyError` |
| 元数据主机（`metadata.google.internal` 及子域、`metadata.azure.internal`、`instance-data`）与元数据地址（`169.254.169.254`、`169.254.170.2`、`100.100.100.200`） | 拒绝 |
| DNS 解析失败 / 结果为空 / 任一地址命中 `blockedAddress` | 拒绝（混合结果 fail closed） |
| IPv4 私网/保留段（0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.0/24、192.168/16、198.18/15、198.51.100/24、203.0.113/24、≥224） | 拒绝 |
| IPv6 未指定/环回/ULA/链路本地/组播/文档段/过渡机制/映射地址且映射目标命中 IPv4 表 | 拒绝 |

## 7 安全与信任

- 这是 SSRF 防护的唯一实现，禁止再拷贝第二份策略表；browser 应用曾持有的
  本地副本已回收为本包依赖；
- 判定失败一律抛 `UrlPolicyError`，message 固定（"URL 被安全策略拒绝"），不携带
  被检地址细节回传给不可信调用方；
- URL 中的用户名/口令视为凭证泄漏尝试，直接拒绝。

## 8 测试契约

- `unit`：公网放行、凭证/非 HTTP/元数据主机/混合 DNS 拒绝、`data`/`blob` 仅子资源、
  IPv4 全保留段与 IPv6 各类地址的 `blockedAddress` 矩阵、公网地址接受集。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| Auth Edge 用户私有模型 SSRF 检查（内联实现） | 抽为共享包 |
| `apps/browser/src/url-policy.ts`（拷贝副本） | 已删除，改为 `dsh-lark-url-policy` workspace 依赖 |
| Auth Edge desktop-inference 用户模型出站 | `assertPublicUrl` 保存/发起前校验 + `createGuardedDispatcher` 连接期判定 |

行为变化：无（合并后语义逐行一致；测试集为两侧超集）。

## 10 开放问题

无。
