/** dsh userQuestions 的飞书交互卡 provider。 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { UserQuestionError, type AskUserQuestionRequest, type AskUserQuestionAnswer } from "@deepseek-ai/dsh-user-questions";
import "dsh-lark-contracts/context";
import "dsh-lark-contracts/events";

import { resolveApprovalConfig, type ApprovalConfigInput } from "./config.js";
import { createApprovalAnswerer } from "./provider.js";
import { MemoryPendingStore } from "./store.js";

export const name = "lark-approval";
export const inject = ["userQuestions", "sessions", "larkScopeIndex"];

export type Config = ApprovalConfigInput;

export const Config: z<Config> = z.object({
  ttlMs: z.number(),
  maxOptions: z.number(),
  maxPendingPerScope: z.number(),
});

export function apply(ctx: Context, config: Config): void {
  const resolved = resolveApprovalConfig(config);
  const store = new MemoryPendingStore({
    ttlMs: resolved.ttlMs,
    maxPendingPerScope: resolved.maxPendingPerScope,
  });
  const answerer = createApprovalAnswerer({
    ctx,
    store,
    maxOptions: resolved.maxOptions,
  });
  ctx.effect(() => {
    // Alpha user-questions 使用 waterfall；旧宿主的 registerProvider 仅作为
    // 迁移窗口兼容，避免已有内嵌调用方在升级期间直接失联。
    const legacy = (ctx.userQuestions as unknown as {
      registerProvider?: (provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }) => () => void;
    } | undefined)?.registerProvider;
    const unregister = legacy
      ? legacy({
          ask: (request) => answerer(request as never, async () => {
            throw new UserQuestionError("no user-questions answerer accepted the request", "NO_PROVIDER");
          }),
        })
      : ctx.on("user-questions/request", answerer);
    return () => {
      unregister();
      store.dispose();
    };
  });
}

export { MemoryPendingStore, StoreFullError } from "./store.js";
export type { InteractionAnswer, PendingRecord } from "./store.js";
