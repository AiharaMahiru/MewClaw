import type { ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-lark-mewclaw-brand";
export const inject = ["webServer"];

/** 端形态选项：desktop 变体（mewclaw-brand-desktop）关闭移动适配样式。 */
export interface MewClawBrandOptions {
  mobile?: boolean;
}

export const PRODUCT_NAME = "MewClaw Harness";
export const FAVICON_PATH = "/mewclaw-brand/favicon.svg";
export const MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest";
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" shape-rendering="geometricPrecision"><style>:root{--bg:#fff;--ink:#181717}@media(prefers-color-scheme:dark){:root{--bg:#181717;--ink:#fff}}.bg{fill:var(--bg)}.ink{fill:var(--ink);stroke:var(--ink)}.cutout{fill:var(--bg);stroke:var(--bg)}</style><circle class="bg" cx="256" cy="256" r="256"/><path class="ink" d="M256 132 C244 132 233 137 222 146 C208 136 196 120 184 96 C179 88 169 90 166 98 C154 130 142 172 134 200 C128 214 125 230 126 246 C123.8 281.9 38.5 324.3 51.2 351.5 A226 226 0 0 0 460.8 351.5 C473.5 324.3 388.2 281.9 386 246 C387 230 384 214 378 200 C358 130 370 172 346 98 C343 90 333 88 328 96 C316 120 304 136 290 146 C279 137 268 132 256 132 Z"/><path class="cutout" fill="none" stroke-width="62" stroke-linecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8"/><path class="ink" fill="none" stroke-width="34" stroke-linecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8"/><path class="cutout" fill="none" stroke-width="62" stroke-linecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3"/><path class="ink" fill="none" stroke-width="34" stroke-linecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3"/><g class="ink" fill="none" stroke-width="10" stroke-linecap="round"><path d="M128 276 L44 252"/><path d="M126 300 L50 296"/></g><g class="cutout" fill="none" stroke-width="15" stroke-linecap="round"><path d="M174 266 Q204 300 234 266"/><path d="M278 266 Q308 300 338 266"/></g><path class="cutout" d="M247 312 L265 312 L256 325 Z" stroke-width="7" stroke-linejoin="round"/></svg>`;
const MANIFEST = JSON.stringify({ id: "/", name: PRODUCT_NAME, short_name: "MewClaw", start_url: "/", scope: "/", display: "fullscreen" });
const BRAND_STYLE = `.mewclaw-sidebar-name{font-family:"Maple Mono NF CN",monospace;font-weight:600}.mewclaw-brand-mark{--mewclaw-mark-bg:#fff;--mewclaw-mark-ink:#181717}.mewclaw-mark-bg{fill:var(--mewclaw-mark-bg)}.mewclaw-mark-ink{fill:var(--mewclaw-mark-ink);stroke:var(--mewclaw-mark-ink)}.mewclaw-mark-cutout{fill:var(--mewclaw-mark-bg);stroke:var(--mewclaw-mark-bg)}body[data-ds-dark-theme] .mewclaw-brand-mark{--mewclaw-mark-bg:#181717;--mewclaw-mark-ink:#fff}`;
const STROKE_ONLY_STYLE = `.mewclaw-mark-ink[fill="none"],.mewclaw-mark-cutout[fill="none"],g.mewclaw-mark-ink,g.mewclaw-mark-cutout{fill:none}`;
const HERO_STYLE = `.mewclaw-hero-brand{display:inline-flex;align-items:center;gap:12px;white-space:nowrap}.mewclaw-hero-copy{display:inline-block;font-size:22px;font-weight:600;line-height:32px;letter-spacing:-.02em}span:has(.mewclaw-hero-brand)+span{display:none}.mewclaw-sidebar-mark{width:24px;height:24px}`;
// 官方前端无移动断点：侧栏列在手机上是侧推挤压而非覆盖（0.1.6 起 <1024px
// 仅有折叠态 56px rail，仍占网格轨道）。利用 CSS Module 稳定后缀
// （<hash>_<name>，重建仅哈希变化）把侧栏改为 fixed 覆盖；侧栏脱离 grid 后
// centerCol 会掉进第一轨，需 grid-column:1/-1 跨全行。移动端由左上角菜单键 +
// 左缘滑动手势开合完整会话抽屉，展开时带暗色遮罩、菜单键随之隐藏。
// 桌面端侧栏背景是半透明（覆盖式抽屉会透出下层会话头部），移动端改为不透明——
// 等优先级规则后被官方样式表覆盖，需 !important。
// 右坞开关去重（全视口）：官方右坞把唯一的展开入口注入会话头部角落
// （data-sidebar-right-expand），与第三方坞簇开关职责重复——隐藏前者，坞簇
// 开关作为默认右侧栏按钮。锚定 data 属性而非 aria-label，避免文案随语言失效。
const DEDUPE_STYLE = `[data-sidebar-right-expand]{display:none!important}`;
// 会话头部顶栏在手机上溢出：隐藏桌面专属控件容器——_headerActions（模式徽标、
// 云端位置选择器、jobs/schedule/终端等槽位集合）与 _headerUtilities（外部编辑器
// 入口）。按容器隐藏与语言无关；顶栏仅剩面包屑与 More actions。
// 坞簇内底部面板开关已由 better-sidebar 按窄屏自行省略（!narrow 渲染），无需再隐。
// 右坞窄屏已有自家浮层（data-dsh-panel-host fixed 铺满 + translate 滑入），但面板
// 底色是 68% 透明毛玻璃（--dsw-alias-bg-layer-1 带 alpha）、无 backdrop 模糊——
// 窄屏下底层聊天文字直接透上来。补 backdrop-filter 保住毛玻璃观感且可读；
// 分栏拖拽柄在触屏无意义，同隐。
const MOBILE_STYLE = `@media(max-width:768px){[class*="_sidebarCol"]{position:fixed;top:0;bottom:0;left:0;z-index:120;height:100dvh;transform:translateX(-110%);visibility:hidden;transition:transform .24s ease,visibility .24s;background-color:rgb(28 28 35)!important}html.mewclaw-rail-open [class*="_sidebarCol"]{transform:none;visibility:visible}html.mewclaw-rail-open .mewclaw-rail-fab{display:none}[data-dsh-panel-host] [class*="_panel"]{-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}[class*="_handle"]{display:none}[class*="_centerCol"]{grid-column:1/-1}[class*="_titleRow"]{padding-left:48px!important}html.mewclaw-rail-open [class*="_centerCol"]::after{content:"";position:fixed;inset:0;z-index:110;background:rgb(0 0 0/.38)}[class*="_titleRow"] [class*="_headerActions"],[class*="_titleRow"] [class*="_headerUtilities"]{display:none!important}}
.mewclaw-rail-edge,.mewclaw-rail-fab{display:none}
@media(max-width:768px){.mewclaw-rail-edge{display:block;position:fixed;left:0;top:0;bottom:0;width:16px;z-index:109;touch-action:pan-y}.mewclaw-rail-fab{display:inline-flex;position:fixed;top:7px;left:9px;z-index:108;width:36px;height:36px;align-items:center;justify-content:center;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer;padding:0}[class*="_toggleCluster"]{top:calc(11px + env(safe-area-inset-top))!important}}`;
// 移动端侧栏开合控制：左上角固定菜单键 + 左缘 16px 起笔右滑展开完整会话抽屉，
// 抽屉上左滑或点遮罩收起并隐藏整条侧栏列。手势用 TouchEvent 而非 PointerEvent——
// 左缘右滑会被浏览器声明为系统手势导致 pointermove 断流，touchmove 不受影响；
// 起笔判定按触点坐标（热区元素可能被下层输入控件遮挡）。脚本仅 DOM 开合，
// 不读凭证、不发请求；桌面视口 matchMedia 短路。
// 折叠态判定锚定 AppFrame 发布的 data-sidebar-collapsed 属性（0.1.6 起挂在
// 布局 frame 上），不读 aria-label——其文案随界面语言变化。MutationObserver
// 兜底所有收起路径（抽屉内官方开关、右坞开启联动、视口跨界）复位 OPEN。
const MOBILE_RAIL_SCRIPT = `<script data-mewclaw-rail>(function(){
if(!matchMedia("(max-width:768px)").matches)return;
var OPEN="mewclaw-rail-open";
function col(){return document.querySelector('[class*="_sidebarCol"]')}
function toggleBtn(){var c=col();return c&&c.querySelector('[class*="_toggle"]')}
function collapsed(){return !!document.querySelector("[data-sidebar-collapsed]")}
function expand(){var t=toggleBtn();if(t&&collapsed())t.click()}
function open(){document.documentElement.classList.add(OPEN);expand();setTimeout(expand,320)}
function close(){var t=toggleBtn();if(t&&!collapsed())t.click();document.documentElement.classList.remove(OPEN)}
new MutationObserver(function(){if(collapsed())document.documentElement.classList.remove(OPEN)}).observe(document.body,{attributes:true,attributeFilter:["data-sidebar-collapsed"],subtree:true});
var fab=document.createElement("button");fab.type="button";fab.setAttribute("aria-label","Menu");
fab.className="mewclaw-rail-fab";
fab.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
fab.addEventListener("click",function(){document.documentElement.classList.contains(OPEN)?close():open()});
document.body.appendChild(fab);
var edge=document.createElement("div");edge.className="mewclaw-rail-edge";document.body.appendChild(edge);
var sx=0,sy=0,track="";
document.addEventListener("touchstart",function(e){var t=e.touches[0];if(!t)return;
if(document.documentElement.classList.contains(OPEN)){var c=col();if(c&&c.contains(e.target)){sx=t.clientX;sy=t.clientY;track="close"}}
else if(edge===e.target||t.clientX<=16){sx=t.clientX;sy=t.clientY;track="open"}},true);
document.addEventListener("touchmove",function(e){if(!track)return;var t=e.touches[0];if(!t)return;var dx=t.clientX-sx,dy=t.clientY-sy;
if(track==="open"&&dx>56&&dx>Math.abs(dy)*1.5){track="";open()}
else if(track==="close"&&dx<-56&&-dx>Math.abs(dy)*1.5){track="";close()}},true);
["touchend","touchcancel"].forEach(function(t){document.addEventListener(t,function(){track=""},true)});
document.addEventListener("pointerdown",function(e){if(!document.documentElement.classList.contains(OPEN))return;var c=col();if(c&&c.contains(e.target))return;if(fab.contains(e.target))return;close()},true);
})()</script>`;
const BOOT_STYLE = `html.mewclaw-boot-seen .mewclaw-boot{display:none}.mewclaw-boot{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;pointer-events:none;background:#f5f5f7;color:#181717;animation:mewclaw-boot-away .32s cubic-bezier(.4,0,1,1) 1.05s forwards}.mewclaw-boot-inner{display:grid;justify-items:center;gap:24px;animation:mewclaw-boot-arrive .52s cubic-bezier(.22,1,.36,1) both}.mewclaw-boot-logo{width:88px;height:88px;border-radius:50%;filter:drop-shadow(0 12px 24px rgb(0 0 0/.12))}.mewclaw-boot-track{width:112px;height:3px;overflow:hidden;border-radius:999px;background:rgb(24 23 23/.12)}.mewclaw-boot-progress{display:block;width:42%;height:100%;border-radius:inherit;background:currentColor;animation:mewclaw-boot-progress .82s cubic-bezier(.2,.8,.2,1) .14s both}@keyframes mewclaw-boot-arrive{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}@keyframes mewclaw-boot-progress{from{transform:translateX(-110%)}to{transform:translateX(250%)}}@keyframes mewclaw-boot-away{to{opacity:0;visibility:hidden}}body[data-ds-dark-theme] .mewclaw-boot{background:#18181a;color:#fff}@media(prefers-color-scheme:dark){html:not([data-ds-theme=light]) .mewclaw-boot{background:#18181a;color:#fff}}@media(prefers-reduced-motion:reduce){.mewclaw-boot,.mewclaw-boot-inner,.mewclaw-boot-progress{animation:none}.mewclaw-boot{opacity:0;visibility:hidden}}`;
const BOOT_MARKUP = `<div class="mewclaw-boot" aria-hidden="true"><div class="mewclaw-boot-inner"><img class="mewclaw-boot-logo" src="${FAVICON_PATH}" alt=""><span class="mewclaw-boot-track"><span class="mewclaw-boot-progress"></span></span></div></div>`;
const BOOT_HEAD_SCRIPT = `<script data-mewclaw-boot>try{if(sessionStorage.getItem("mewclaw.boot.v1"))document.documentElement.classList.add("mewclaw-boot-seen")}catch{}</script>`;
const BOOT_END_SCRIPT = `<script data-mewclaw-boot-end>(()=>{const boot=document.querySelector(".mewclaw-boot");if(!boot)return;try{sessionStorage.setItem("mewclaw.boot.v1","1")}catch{}const remove=()=>boot.remove();boot.addEventListener("animationend",event=>{if(event.animationName==="mewclaw-boot-away")remove()},{once:true});setTimeout(remove,1600)})()</script>`;
const FAVICON_RESPONSE = FAVICON_SVG.replace("</style>", `.ink[fill="none"],.cutout[fill="none"],g.ink,g.cutout{fill:none}</style>`);

/** Host 品牌资源与 HTML 元数据均通过 WebServer 的公开路由/transform 扩展点提供。 */
export function apply(ctx: Context, options?: MewClawBrandOptions): void {
  const mobileStyle = options?.mobile === false ? "" : MOBILE_STYLE;
  ctx.effect(() => ctx.webServer.tapIndex((html) => html
    .replace(/<html(?:\s+lang="[^"]*")?>/u, '<html lang="zh-CN">')
    .replace(/<title>[^<]*<\/title>/u, `<title>${PRODUCT_NAME}</title>`)
    .replace(/(<link\b[^>]*rel="icon"[^>]*href=")[^"]*(")/u, `$1${FAVICON_PATH}$2`)
    .replace(/(<link\b[^>]*rel="manifest"[^>]*href=")[^"]*(")/u, `$1${MANIFEST_PATH}$2`)
    .replace("</head>", `${BOOT_HEAD_SCRIPT}<style data-mewclaw-brand>${BRAND_STYLE}${STROKE_ONLY_STYLE}${HERO_STYLE}${DEDUPE_STYLE}${mobileStyle}${BOOT_STYLE}</style></head>`)
    .replace(/<body([^>]*)>/u, `<body$1>${BOOT_MARKUP}`)
    .replace("</body>", `${options?.mobile === false ? "" : MOBILE_RAIL_SCRIPT}${BOOT_END_SCRIPT}</body>`)));
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: FAVICON_PATH, handler: (_req, res) => respond(res, "image/svg+xml; charset=utf-8", FAVICON_RESPONSE) }));
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: MANIFEST_PATH, handler: (_req, res) => respond(res, "application/manifest+json; charset=utf-8", MANIFEST) }));
}

function respond(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body), "cache-control": "public, max-age=300" });
  res.end(body);
}

export {
  MEWCLAW_MARK_HEIGHT,
  MEWCLAW_MARK_VIEWBOX,
  MEWCLAW_MARK_WIDTH,
  renderMewClawBrandMark,
} from "./mark.js";
export type { MewClawBrandMarkProps, ReactApi } from "./mark.js";
