# dsh-lark-mewclaw-brand SPEC（MewClaw 品牌插件 · Web/移动）

| 元数据 | 值 |
| --- | --- |
| 包 | `dsh-lark-mewclaw-brand`（Plugin，web bundle + client slot） |
| 位置 | `packages/lark/mewclaw-brand/` |
| 角色 | MewClaw 品牌的唯一合法注入点：WebServer `tapIndex`/`register` + 客户端公开 slots |
| 里程碑 | 贯穿（升级硬门禁，见 release.md §1.1） |
| 状态 | implemented |
| 依赖能力 | `ctx.webServer`（transform/route）、`ctx.slots`（客户端） |
| 提供能力 | `/mewclaw-brand/favicon.svg`、`/mewclaw-brand/manifest.webmanifest`、`conversation.hero.brand.mark`、`sidebar.brand.mark`、`sidebar.brand.name`、MewClaw 商标几何（`renderMewClawBrandMark`） |

## 1 目的与边界

为 Web UI 提供 MewClaw 品牌（产品名 "MewClaw Harness"、商标、启动屏、hero/sidebar
标识），**只能通过官方公开扩展点实现**：

- `ctx.webServer.tapIndex` — index HTML 的 transform（lang/title/icon/manifest/品牌样式/启动屏）；
- `ctx.webServer.register` — 精确路径路由（favicon、manifest）；
- `ctx.slots` — 客户端公开槽位（hero/sidebar 标识与文案）。

非目标与硬约束：不改官方 `@deepseek-ai/dsh-*` 包的任何文件、资源或 UI；不用
私有/未公开钩子；不覆盖上游路由；不引入外部资源（商标为内联 SVG，无网络请求）。

## 2 服务契约

```ts
export function apply(ctx: Context): void
//   ctx.effect(() => ctx.webServer.tapIndex(transform))
//   ctx.effect(() => ctx.webServer.register({ kind:"exact", path:FAVICON_PATH, handler }))
//   ctx.effect(() => ctx.webServer.register({ kind:"exact", path:MANIFEST_PATH, handler }))

export const PRODUCT_NAME = "MewClaw Harness"
export const FAVICON_PATH  = "/mewclaw-brand/favicon.svg"
export const MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest"
export const FAVICON_SVG   // 自适应明暗主题的内联 SVG
export function renderMewClawBrandMark(React: ReactApi, props: {size:number;className?:string}): unknown
```

客户端 `client.ts` 经官方 `__ModuleLoader__` 注册 `apply(ctx)`：
`ctx.slots.inject/register` 占据 `conversation.hero.brand.mark`（hero 文案一次
随机固定）、`sidebar.brand.mark`、`sidebar.brand.name`；**等待官方槽位声明后才
注册**，不抢先在槽位不存在时写。

## 3 配置契约

无配置（品牌即代码常量；favicon/manifest 缓存 `public, max-age=300`）。

## 4 事件契约

无。

## 5 模型可见面

无（品牌不进模型请求；启动屏 `sessionStorage` 标记 `mewclaw.boot.v1` 只控制
本页是否重播动画，属 UI 本地状态）。

## 6 行为契约

- `tapIndex` 只做字符串 transform：`lang="zh-CN"`、`<title>`、icon/manifest
  `href` 改写、`<head>` 注入品牌样式与启动屏脚本、`<body>` 注入启动屏标记；
- favicon 响应在 `FAVICON_SVG` 基础上覆盖描边样式，manifest 响应
  `application/manifest+json`；
- 启动屏：`prefers-reduced-motion` 下不播放；~1.05s 后淡出并自删，失败兜底
  1600ms `setTimeout` 移除；
- 移动适配：官方前端无移动断点，`≤768px` 视口下左侧栏列仍占 grid 轨侧推
  挤压主列。注入样式把 `[class*="_sidebarCol"]` 改为 `fixed` 覆盖层
  （`top/bottom/left:0`，`z-index:120`，`height:100dvh`）；侧栏脱离 grid 布局后
  `centerCol` 会落进 56px 的首轨，须以 `grid-column:1/-1` 跨满全行；选择器用
  CSS Module 稳定后缀（`<hash>_<name>`，重建仅哈希变化），不改官方包；
- 移动端侧栏折叠：`≤768px` 时整条 `sidebarCol`（含 55px 图标栏）默认
  `translateX(-110%)+visibility:hidden` 收起，`centerCol` 占满视口。注入的
  `data-mewclaw-rail` 脚本提供左缘滑动手势：body 末端挂 16px 热区
  `mewclaw-rail-edge`（`touch-action:pan-y`），触笔右滑 >56px 且明显横向即置
  `html.mewclaw-rail-open` 并点开完整会话抽屉；抽屉上左滑、`pointerdown`
  落在列外（遮罩）或抽屉内折叠键即收起。手势监听用 TouchEvent 而非
  PointerEvent——左缘右滑会被浏览器声明为系统手势令 pointermove 断流，
  touchmove 不受影响。脚本只做 DOM 开合，不读凭证、不发请求，
  `matchMedia` 在桌面视口短路；
- 移动端抽屉不透明：官方侧栏背景为半透明 `rgba(28 28 35 / .5)`，桌面内联
  无碍但作为覆盖层会透出下层内容；`≤768px` 下 `sidebarCol` 背景改不透明
  （官方样式表同级规则在其后，须 `!important`）；
- 移动端顶栏收纳：会话头部顶栏控件按桌面密度排列，390px 下溢出重叠。
  `≤768px` 隐藏桌面专属/重复控件（按官方 `aria-label` 选择）：
  "Open workspace in Cursor"、"Choose an app to open in"（外部编辑器入口）、
  "Open right sidebar"（会话头部自带右坞开关，与坞簇 Expand sidebar 重复）、
  "Expand bottom panel"（底部坞移动端无内容）。保留面包屑、More actions
  与坞簇 Expand sidebar；
- 所有注册经 `ctx.effect()`/`ctx.slots.inject`，卸载即回收。

## 7 安全与信任

- 升级硬门禁（release.md §1.1）：`pnpm verify:dsh-brand` 验证本插件只占据公开
  slots/transform/route、官方包保持原样；未通过不得接受 DSH 升级；
- 品牌资产为仓库内联常量，无外链脚本/图片，无供应链面；
- 注入的 `<script>` 仅为启动屏自删逻辑与移动端侧栏开合（DOM-only，
  `data-mewclaw-rail`），不读凭证、不发请求。

## 8 测试契约

- `unit`：使用指定 MewClaw 商标几何；不引用 DeepSeek 鱼形组件或外部资源；经
  WebServer 扩展点提供标题/语言/favicon/manifest；
- `client`：等待官方 conversation 槽位声明后再注册占位者；
- 移动适配以真实浏览器验收为准：390px 视口下侧栏默认收起、左缘右滑展开为
  不透明覆盖层抽屉、抽屉左滑/遮罩外点可收起、主列不被挤压、无横向溢出
  （`scrollWidth ≤ 视口宽`）；会话视图顶栏仅面包屑 + More actions +
  坞簇 Expand sidebar，无重叠、无侧栏菜单按钮；
- 门禁：`pnpm verify:dsh-brand`（官方完整性 + 品牌 slot 白名单）。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| lark-claw 品牌资产（DoorAgent 时代） | 重做为 MewClaw 商标 + "MewClaw Harness" 产品名 |
| `dsh-lark-atw-brand` | 包改名为 `dsh-lark-mewclaw-brand`（atw 为 AutoWell 旧名）；桌面端拆分为 `dsh-lark-mewclaw-brand-desktop` |

行为变化：产品名与商标替换；启动屏为新增（DSH 原生无开屏）。

## 10 开放问题

无。
