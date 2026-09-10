import type { ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-lark-atw-brand";
export const inject = ["webServer"];

export const PRODUCT_NAME = "MewClaw Harness";
export const FAVICON_PATH = "/mewclaw-brand/favicon.svg";
export const MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest";
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" shape-rendering="geometricPrecision"><style>:root{--bg:#fff;--ink:#181717}@media(prefers-color-scheme:dark){:root{--bg:#181717;--ink:#fff}}.bg{fill:var(--bg)}.ink{fill:var(--ink);stroke:var(--ink)}.cutout{fill:var(--bg);stroke:var(--bg)}</style><circle class="bg" cx="256" cy="256" r="256"/><path class="ink" d="M256 132 C244 132 233 137 222 146 C208 136 196 120 184 96 C179 88 169 90 166 98 C154 130 142 172 134 200 C128 214 125 230 126 246 C123.8 281.9 38.5 324.3 51.2 351.5 A226 226 0 0 0 460.8 351.5 C473.5 324.3 388.2 281.9 386 246 C387 230 384 214 378 200 C358 130 370 172 346 98 C343 90 333 88 328 96 C316 120 304 136 290 146 C279 137 268 132 256 132 Z"/><path class="cutout" fill="none" stroke-width="62" stroke-linecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8"/><path class="ink" fill="none" stroke-width="34" stroke-linecap="round" d="M116.9 410.6 A208 208 0 0 0 234.2 462.8"/><path class="cutout" fill="none" stroke-width="62" stroke-linecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3"/><path class="ink" fill="none" stroke-width="34" stroke-linecap="round" d="M366.2 432.4 A208 208 0 0 0 462.9 234.3"/><g class="ink" fill="none" stroke-width="10" stroke-linecap="round"><path d="M128 276 L44 252"/><path d="M126 300 L50 296"/></g><g class="cutout" fill="none" stroke-width="15" stroke-linecap="round"><path d="M174 266 Q204 300 234 266"/><path d="M278 266 Q308 300 338 266"/></g><path class="cutout" d="M247 312 L265 312 L256 325 Z" stroke-width="7" stroke-linejoin="round"/></svg>`;
const MANIFEST = JSON.stringify({ id: "/", name: PRODUCT_NAME, short_name: "MewClaw", start_url: "/", scope: "/", display: "fullscreen" });
const BRAND_STYLE = `.mewclaw-sidebar-name{font-family:"Maple Mono NF CN",monospace;font-weight:600}.mewclaw-brand-mark{--mewclaw-mark-bg:#fff;--mewclaw-mark-ink:#181717}.mewclaw-mark-bg{fill:var(--mewclaw-mark-bg)}.mewclaw-mark-ink{fill:var(--mewclaw-mark-ink);stroke:var(--mewclaw-mark-ink)}.mewclaw-mark-cutout{fill:var(--mewclaw-mark-bg);stroke:var(--mewclaw-mark-bg)}body[data-ds-dark-theme] .mewclaw-brand-mark{--mewclaw-mark-bg:#181717;--mewclaw-mark-ink:#fff}`;
const STROKE_ONLY_STYLE = `.mewclaw-mark-ink[fill="none"],.mewclaw-mark-cutout[fill="none"],g.mewclaw-mark-ink,g.mewclaw-mark-cutout{fill:none}`;
const HERO_STYLE = `.mewclaw-hero-brand{display:inline-flex;align-items:center;gap:12px;white-space:nowrap}.mewclaw-hero-copy{display:inline-block;font-size:22px;font-weight:600;line-height:32px;letter-spacing:-.02em}span:has(.mewclaw-hero-brand)+span{display:none}.mewclaw-sidebar-mark{width:24px;height:24px}`;
const BOOT_STYLE = `html.mewclaw-boot-seen .mewclaw-boot{display:none}.mewclaw-boot{position:fixed;z-index:2147483647;inset:0;display:grid;place-items:center;pointer-events:none;background:#f5f5f7;color:#181717;animation:mewclaw-boot-away .32s cubic-bezier(.4,0,1,1) 1.05s forwards}.mewclaw-boot-inner{display:grid;justify-items:center;gap:24px;animation:mewclaw-boot-arrive .52s cubic-bezier(.22,1,.36,1) both}.mewclaw-boot-logo{width:88px;height:88px;border-radius:50%;filter:drop-shadow(0 12px 24px rgb(0 0 0/.12))}.mewclaw-boot-track{width:112px;height:3px;overflow:hidden;border-radius:999px;background:rgb(24 23 23/.12)}.mewclaw-boot-progress{display:block;width:42%;height:100%;border-radius:inherit;background:currentColor;animation:mewclaw-boot-progress .82s cubic-bezier(.2,.8,.2,1) .14s both}@keyframes mewclaw-boot-arrive{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}@keyframes mewclaw-boot-progress{from{transform:translateX(-110%)}to{transform:translateX(250%)}}@keyframes mewclaw-boot-away{to{opacity:0;visibility:hidden}}body[data-ds-dark-theme] .mewclaw-boot{background:#18181a;color:#fff}@media(prefers-color-scheme:dark){html:not([data-ds-theme=light]) .mewclaw-boot{background:#18181a;color:#fff}}@media(prefers-reduced-motion:reduce){.mewclaw-boot,.mewclaw-boot-inner,.mewclaw-boot-progress{animation:none}.mewclaw-boot{opacity:0;visibility:hidden}}`;
const BOOT_MARKUP = `<div class="mewclaw-boot" aria-hidden="true"><div class="mewclaw-boot-inner"><img class="mewclaw-boot-logo" src="${FAVICON_PATH}" alt=""><span class="mewclaw-boot-track"><span class="mewclaw-boot-progress"></span></span></div></div>`;
const BOOT_HEAD_SCRIPT = `<script data-mewclaw-boot>try{if(sessionStorage.getItem("mewclaw.boot.v1"))document.documentElement.classList.add("mewclaw-boot-seen")}catch{}</script>`;
const BOOT_END_SCRIPT = `<script data-mewclaw-boot-end>(()=>{const boot=document.querySelector(".mewclaw-boot");if(!boot)return;try{sessionStorage.setItem("mewclaw.boot.v1","1")}catch{}const remove=()=>boot.remove();boot.addEventListener("animationend",event=>{if(event.animationName==="mewclaw-boot-away")remove()},{once:true});setTimeout(remove,1600)})()</script>`;
const FAVICON_RESPONSE = FAVICON_SVG.replace("</style>", `.ink[fill="none"],.cutout[fill="none"],g.ink,g.cutout{fill:none}</style>`);

/** Host 品牌资源与 HTML 元数据均通过 WebServer 的公开路由/transform 扩展点提供。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.tapIndex((html) => html
    .replace(/<html(?:\s+lang="[^"]*")?>/u, '<html lang="zh-CN">')
    .replace(/<title>[^<]*<\/title>/u, `<title>${PRODUCT_NAME}</title>`)
    .replace(/(<link\b[^>]*rel="icon"[^>]*href=")[^"]*(")/u, `$1${FAVICON_PATH}$2`)
    .replace(/(<link\b[^>]*rel="manifest"[^>]*href=")[^"]*(")/u, `$1${MANIFEST_PATH}$2`)
    .replace("</head>", `${BOOT_HEAD_SCRIPT}<style data-mewclaw-brand>${BRAND_STYLE}${STROKE_ONLY_STYLE}${HERO_STYLE}${BOOT_STYLE}</style></head>`)
    .replace(/<body([^>]*)>/u, `<body$1>${BOOT_MARKUP}`)
    .replace("</body>", `${BOOT_END_SCRIPT}</body>`)));
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
