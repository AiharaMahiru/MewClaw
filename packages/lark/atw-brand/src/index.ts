import type { ServerResponse } from "node:http";

import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";

export const name = "dsh-lark-atw-brand";
export const inject = ["webServer"];

export const PRODUCT_NAME = "MewClaw Harness";
export const FAVICON_PATH = "/mewclaw-brand/favicon.svg";
export const MANIFEST_PATH = "/mewclaw-brand/manifest.webmanifest";
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><style>:root{color:#111}@media(prefers-color-scheme:dark){:root{color:#f5f7f8}}</style><defs><mask id="v-under"><rect width="240" height="240" fill="#fff"/><path d="M76 90h28" stroke="#000" stroke-width="18"/><path d="M136 150h28" stroke="#000" stroke-width="18"/></mask></defs><g transform="rotate(45 120 120)" fill="none" stroke="currentColor" stroke-width="16"><rect x="35" y="90" width="170" height="60" rx="30"/><rect x="90" y="35" width="60" height="170" rx="30" mask="url(#v-under)"/></g></svg>`;
const MANIFEST = JSON.stringify({ id: "/", name: PRODUCT_NAME, short_name: "MewClaw", start_url: "/", scope: "/", display: "fullscreen" });
const BRAND_STYLE = `.mewclaw-sidebar-name{font-family:"Maple Mono NF CN",monospace;font-weight:600}`;

/** Host 品牌资源与 HTML 元数据均通过 WebServer 的公开路由/transform 扩展点提供。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.tapIndex((html) => html
    .replace(/<html(?:\s+lang="[^"]*")?>/u, '<html lang="zh-CN">')
    .replace(/<title>[^<]*<\/title>/u, `<title>${PRODUCT_NAME}</title>`)
    .replace(/(<link\b[^>]*rel="icon"[^>]*href=")[^"]*(")/u, `$1${FAVICON_PATH}$2`)
    .replace(/(<link\b[^>]*rel="manifest"[^>]*href=")[^"]*(")/u, `$1${MANIFEST_PATH}$2`)
    .replace("</head>", `<style data-mewclaw-brand>${BRAND_STYLE}</style></head>`)));
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: FAVICON_PATH, handler: (_req, res) => respond(res, "image/svg+xml; charset=utf-8", FAVICON_SVG) }));
  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: MANIFEST_PATH, handler: (_req, res) => respond(res, "application/manifest+json; charset=utf-8", MANIFEST) }));
}

function respond(res: ServerResponse, contentType: string, body: string): void {
  res.writeHead(200, { "content-type": contentType, "content-length": Buffer.byteLength(body), "cache-control": "public, max-age=300" });
  res.end(body);
}

export {
  MEWCLAW_MARK_HEIGHT,
  MEWCLAW_MARK_MASK_ID,
  MEWCLAW_MARK_VIEWBOX,
  MEWCLAW_MARK_WIDTH,
  renderMewClawBrandMark,
} from "./mark.js";
export type { MewClawBrandMarkProps, ReactApi } from "./mark.js";
