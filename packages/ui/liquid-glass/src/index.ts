/** Host 仅传递公开视觉配置；不修改官方客户端产物。 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-host-webserver";
import { CONFIG_ID, PLUGIN_ID, resolveConfig } from "./config.js";

export const name = PLUGIN_ID;
export const inject = ["webServer"];

/**
 * 注册受生命周期管理的 HTML 配置贡献。
 * @param ctx - 提供官方 WebServer 的 Host context。
 * @param input - 可选的视觉配置，非法项在插件加载时抛错。
 */
export function apply(ctx: Context, input: unknown = {}): void {
  const config = resolveConfig(input);
  if (!config.enabled) return;
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  ctx.effect(() => ctx.webServer.tapIndex((html) => html.replace("</head>",
    `<script type="application/json" id="${CONFIG_ID}">${json}</script></head>`)));
}
