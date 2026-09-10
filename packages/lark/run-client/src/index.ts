/**
 * dsh-lark-run-client 插件入口（SPEC lark-run-client.md §3）。
 *
 * 提供 ctx.larkRunClient：token 经凭证引用读取（tokenEnv 缺省 = 不带
 * 鉴权头，仅限本机开发）；流错误经 lark/run/stream/error 发布。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

import { createRunClient } from "./client.js";
import { resolveRunClientConfig } from "./config.js";
import "./events.js";

export const name = "lark-run-client";

export const inject = ["credentials"];

export interface Config {
  /** worker 基址（含协议与端口）。 */
  baseURL: string;
  /** worker 凭证引用名；与 lark-run 一致。缺省 = 不带鉴权头。 */
  tokenEnv?: string;
  /** 请求超时（默认 30s，仅覆盖连接与首字节）。 */
  connectTimeoutMs?: number;
  /** 心跳容忍（默认 45s = 3 × 心跳间隔）。 */
  heartbeatToleranceMs?: number;
  /** 单事件行字节上限（默认 64 KiB）。 */
  maxEventBytes?: number;
  /** 非流式 Worker JSON 响应字节上限（默认 32 MiB）。 */
  maxResponseBytes?: number;
}

export const Config: z<Config> = z.object({
  baseURL: z.string().required(),
  tokenEnv: z.string(),
  connectTimeoutMs: z.number(),
  heartbeatToleranceMs: z.number(),
  maxEventBytes: z.number(),
  maxResponseBytes: z.number(),
});

export async function apply(ctx: Context, config: Config): Promise<void> {
  const limits = resolveRunClientConfig(config);
  /** 活跃守卫：dispose 后异步初始化不再 provide（防 INACTIVE_EFFECT）。 */
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  let token: string | undefined;
  if (config.tokenEnv) {
    const resolved = await ctx.credentials!.resolve(config.tokenEnv as CredentialRef);
    if (!resolved) {
      throw new Error(`lark-run-client: 凭证引用未配置（${config.tokenEnv}）——token 值绝不写入配置`);
    }
    token = resolved.value;
  } else {
    ctx.logger.warn("lark-run-client: 未配置 tokenEnv，桥接请求不带鉴权头（仅限本机开发）");
  }
  const client = createRunClient({
    baseURL: config.baseURL,
    ...(token ? { token } : {}),
    ...limits,
    onStreamError: (runId, code) => ctx.emit("lark/run/stream/error", { runId, code }),
  });
  if (!active) return;
  ctx.provide("larkRunClient", client);
}

// 包的公开类型面（gateway 等从这里导入）。
export * from "./client.js";
