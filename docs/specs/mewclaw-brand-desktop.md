# dsh-lark-mewclaw-brand-desktop SPEC（MewClaw 品牌插件 · 桌面变体）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-mewclaw-brand-desktop`（Plugin，desktop bundle + client slot） |
| 位置 | `packages/lark/mewclaw-brand-desktop/` |
| 角色 | 桌面端品牌的合法注入点：与 Web 版共享商标几何/槽位/资源路由 |
| 里程碑 | 贯穿（升级硬门禁，见 release.md §1.1） |
| 状态 | implemented |
| 依赖能力 | `ctx.webServer`（transform/route）、`dsh-lark-mewclaw-brand`（共享实现） |
| 提供能力 | 同 `dsh-lark-mewclaw-brand`：favicon/manifest 路由、hero/sidebar 槽位 |

## 1 目的与边界

桌面端（Electron 本地 Web Server）与 Web/移动端的 MewClaw 品牌一致，但
**不注入移动适配样式**（`≤768px` 断点对桌面视口无意义，且避免与未来桌面
专属布局冲突）。本包是 `dsh-lark-mewclaw-brand` 的薄变体，不重复实现：

- Host：`apply(ctx)` 调用 `dsh-lark-mewclaw-brand` 的 `apply(ctx, { mobile:false })`；
- Client：`client.ts` 复用 `dsh-lark-mewclaw-brand/client-impl` 的 `applyBrand`，
  仅以不同 ModuleLoader id（`dsh-lark-mewclaw-brand-desktop`）注册；
- 不改官方 `@deepseek-ai/dsh-*` 包的任何文件、资源或 UI。

## 2 服务契约

```ts
export function apply(ctx: Context): void
export const name = "dsh-lark-mewclaw-brand-desktop"
export const inject = ["webServer"]
```

资源路由与产品名继承自 `dsh-lark-mewclaw-brand`（`/mewclaw-brand/*`）。

## 3 配置契约

无（`mobile:false` 为内置常量，不暴露配置）。

## 4 事件契约

无。

## 5 模型可见面

无。

## 6 行为契约

- 与 Web 版一致的 transform/route 行为，仅缺省 `MOBILE_STYLE`；
- 客户端槽位注册与 Web 版共享 `applyBrand` 实现；
- 所有注册经 `ctx.effect()`/`ctx.slots.inject`，卸载即回收。

## 7 安全与信任

同 `dsh-lark-mewclaw-brand`：升级硬门禁、内联资产、无外链。

## 8 测试契约

- `unit`：transform 输出含品牌资源但不含 `@media(max-width:768px)`；
- 消费方（desktop-dev `local-brand.ts`）经 `require.resolve("dsh-lark-mewclaw-brand-desktop/client")`
  取客户端 bundle。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| `dsh-lark-atw-brand` | 改名为 `dsh-lark-mewclaw-brand`；本包为桌面变体 |

行为变化：无（桌面端此前复用 Web 版品牌，本包仅去掉移动适配样式）。

## 10 开放问题

无。
