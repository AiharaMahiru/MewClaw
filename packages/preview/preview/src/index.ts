import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";

import { PreviewHttpClient } from "./client.js";
import { Config as ConfigSchema, resolveClientConfig, type Config as PreviewConfig } from "./config.js";
import type { PreviewService } from "./types.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 当前 Worker 的公共 Web/API 分享能力。 */
    preview?: PreviewService;
  }
}

export const name = "preview";
export const inject = ["credentials"];
export const Config = ConfigSchema;
export type Config = PreviewConfig;

export async function apply(ctx: Context, config: PreviewConfig): Promise<void> {
  const resolvedConfig = resolveClientConfig(config);
  const credential = await ctx.credentials!.resolve(resolvedConfig.tokenEnv as CredentialRef);
  if (!credential?.value) {
    throw new Error(`dsh-preview: 凭证引用未配置（${resolvedConfig.tokenEnv}）`);
  }
  const service = new PreviewHttpClient({
    baseUrl: resolvedConfig.previewBaseUrl,
    token: credential.value,
    requestTimeoutMs: resolvedConfig.requestTimeoutMs,
  });
  ctx.provide("preview", service);
  ctx.effect(() => () => service.dispose());
}

export * from "./client.js";
export * from "./config.js";
export * from "./types.js";
