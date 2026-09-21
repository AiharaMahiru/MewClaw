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
  挤压主列（0.1.6 起 `<1024px` 即 narrow，仅给折叠态 56px rail）。移动适配
  断点与上游 narrow 对齐为 `≤1023px`。注入样式把 `[class*="_sidebarCol"]` 改为 `fixed` 覆盖层
  （`top/bottom/left:0`，`z-index:120`，`height:100dvh`）；侧栏脱离 grid 布局后
  `centerCol` 会落进 56px 的首轨，须以 `grid-column:1/-1` 跨满全行；选择器用
  CSS Module 稳定后缀（`<hash>_<name>`，重建仅哈希变化），不改官方包；
- 移动端侧栏折叠：`≤1023px` 时整条 `sidebarCol`（含 56px 图标栏）默认
  `translateX(-110%)+visibility:hidden` 收起，`centerCol` 占满视口。注入的
  `data-mewclaw-rail` 脚本提供两种开合方式：左上角固定菜单键
  `mewclaw-rail-fab`（fixed top-left，`z-index` 低于抽屉/遮罩，抽屉展开时被
  覆盖；`_titleRow` 左 padding 让位）与左缘滑动手势——触笔起笔于左缘 16px 内
  （`clientX<=16`，热区 `mewclaw-rail-edge` 可能被下层控件遮挡，按坐标判定）
  右滑 >56px 且明显横向即置 `html.mewclaw-rail-open` 并点开完整会话抽屉——
  展开按 AppFrame 发布的 `data-sidebar-collapsed` 属性判定（0.1.6 起挂在
  布局 frame 上，窄屏折叠态为真）：属性存在时点官方开关扩为完整抽屉，
  立即 + 320ms 各检查一次，不依赖 aria 文案（其随界面语言变化）；
  抽屉上左滑、`pointerdown` 落在列外（遮罩）、抽屉内折叠键、右坞开启
  联动收起或视口跨界即收起——`MutationObserver` 监听
  `data-sidebar-collapsed` 出现即复位 `mewclaw-rail-open`，覆盖全部收起
  路径。官方右侧栏抽屉展开（`data-sidebar-right-open="true"`）时
  fab/edge 整体隐藏——其 z-index（108/109）高于抽屉（40），透出会与
  抽屉头按钮视觉堆叠，edge 热区还会拦截抽屉左缘触控。手势监听用
  TouchEvent 而非
  PointerEvent——左缘右滑会被浏览器声明为系统手势令 pointermove 断流，
  touchmove 不受影响。脚本只做 DOM 开合，不读凭证、不发请求，
  `matchMedia` 在桌面视口短路；
- 移动端抽屉不透明：官方侧栏背景为半透明 `rgba(28 28 35 / .5)`，桌面内联
  无碍但作为覆盖层会透出下层内容；`≤1023px` 下 `sidebarCol` 背景改不透明
  （官方样式表同级规则在其后，须 `!important`）；
- 液态玻璃下坞面板与官方右侧栏不透明（全视口）：liquid-glass 把
  `--dsw-alias-bg-layer-1`/`--dsw-alias-bg-base` 降为透明色，better-sidebar
  坞面板是纯 `div`（非 dialog/menu 语义），官方右侧栏则使用
  `[data-sidebar-right-panel]`，两者都不应把可读性押在 backdrop-filter 上；移动端
  虽有品牌层补 `blur(20px)`，但部分 WebView 声明支持却不真实渲染（软渲染/GPU
  黑名单），桌面端也没有可靠的模糊补偿。`html[data-mew-glass]` 下将
  `[data-dsh-panel]`/`[data-dsh-float-window]`、`[data-sidebar-right-panel]` 与
  右侧浮层首层抬回不透明 `var(--mew-canvas)`，可读性不依赖模糊是否真实渲染；
- 右坞折叠入口与顶部几何：官方右坞把唯一展开入口注入会话头部角落
  （`data-sidebar-right-expand`），且只在折叠态渲染；品牌层不得全局隐藏该入口，
  否则右坞收起后无法恢复。官方 push 面板以 `top:0; bottom:0`
  填满右侧轨道，DockSurface 的 tab strip 就是面板顶部；品牌层只显式归零这两个边，
  不得为对齐内容下移整个面板，避免顶部灰条、高度缩短和 chrome/icon 错位。
  移动视口 `<768px` 时官方自动选择 fullscreen；品牌移动适配层显式保持
  `position:fixed; inset:0; width:100%` 以防其他主题规则污染全视口几何。
  右坞内 dockkit strip(38px) + editorHeader(41px) 的第一条分割线落在 y=79，
  与主区会话 header 底边 y=85 错开 6px；品牌层把右坞内 `_editorHeader`
  撑高到 47px（`box-sizing:border-box; min-height:47px`）使两条横线共线。
  规则只限 `[data-sidebar-right-panel]` 内，底部工作台面板无横向共线对象、保持原高。
- 移动端顶栏收纳：会话头部顶栏控件按桌面密度排列，390px 下溢出重叠。
  `≤768px` 按容器隐藏桌面专属控件槽位（与语言无关）：`_titleRow` 内
  `_headerActions`（模式徽标 + "☁云端" 位置选择器、jobs/schedule/终端等，
  移动 Web 只有云端）与 `_headerUtilities`（外部编辑器入口）。
  坞簇内底部面板开关由 better-sidebar 按窄屏自行省略。保留面包屑、
  More actions 与坞簇开关；
- 移动端文件预览工具栏收缩：文件编辑器的路径输入框与预览/编辑、保存、刷新、
  文件树按钮同属一条 flex 行。`≤1023px` 为面板、pane、editor 和工具栏补齐
  `min-width:0`/`max-width:100%` 收缩链，并让路径输入框以 `width:0` 参与剩余空间分配，
  同时截断过长路径文本；规则同时覆盖 better-sidebar 坞面板与官方右侧栏，桌面端不变，
  目标是手机视口 `scrollWidth ≤ clientWidth` 且所有操作按钮仍可点击；
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
  （`scrollWidth ≤ 视口宽`）；会话视图顶栏为左上角菜单键 + 面包屑 +
  More actions + 坞簇 Expand sidebar，无重叠；
- 右坞布局：桌面 push 面板 `top === 0` 且 `bottom === 视口底部`，无顶部灰色空带；
  右坞内 `_editorHeader` 底边框与主区会话 header 底边共线（均在 y=85）；
  390px 真实路径必须渲染 `data-sidebar-right-panel="fullscreen"`，面板四边为 0、高度等于
  视口高度，`data-sidebar-right-mode` 与 `data-sidebar-right-toggle` 保持在顶部 tab strip 内且不溢出；
- 门禁：`pnpm verify:dsh-brand`（官方完整性 + 品牌 slot 白名单）。

## 9 迁移映射

| 来源 | 处置 |
| --- | --- |
| lark-claw 品牌资产（DoorAgent 时代） | 重做为 MewClaw 商标 + "MewClaw Harness" 产品名 |
| `dsh-lark-atw-brand` | 包改名为 `dsh-lark-mewclaw-brand`（atw 为 AutoWell 旧名）；桌面端拆分为 `dsh-lark-mewclaw-brand-desktop` |

行为变化：产品名与商标替换；启动屏为新增（DSH 原生无开屏）。

## 10 开放问题

无。
