import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";

import { BrowserHttpClient } from "./client.js";
import { Config as ConfigSchema, resolveClientConfig, type Config as BrowserConfig } from "./config.js";
import type { BrowserService } from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 当前 Worker 的隔离浏览器自动化能力。 */
    browser?: BrowserService;
  }
}

export const name = "dsh-browser";
export const inject = ["credentials"];
export const Config = ConfigSchema;
export type Config = BrowserConfig;

export async function apply(ctx: Context, config: BrowserConfig): Promise<void> {
  const resolved = resolveClientConfig(config);
  const credential = await ctx.credentials!.resolve(resolved.tokenEnv as CredentialRef);
  if (!credential?.value) throw new Error(`dsh-browser: 凭证引用未配置（${resolved.tokenEnv}）`);
  const service = new BrowserHttpClient({
    baseUrl: resolved.browserBaseUrl,
    token: credential.value,
    requestTimeoutMs: resolved.requestTimeoutMs,
  });
  ctx.provide("browser", service);
  ctx.effect(() => () => service.dispose());
}

export * from "./client.js";
export * from "./config.js";
export * from "./types.js";
