/**
 * dsh-lark-card 插件入口（SPEC lark-card.md）。
 *
 * 提供 ctx.larkCard：投递策略（处理卡/节流增量/终态替换/失败卡），
 * 全部经 ctx.lark 投递；更新失败做有界退避重试。
 * 事件 → 文本映射的纯函数在 render.ts（gateway 编排调用）。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { renderMarkdownCard, type LarkApi } from "dsh-lark";
import type { ChatId, MessageId } from "dsh-lark-contracts";

import { CardThrottle } from "./throttle.js";
import { resolveCardConfig } from "./config.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 卡片投递服务（网关宿主面，不进模型上下文）。 */
    larkCard?: LarkCardService;
  }
}

export const name = "lark-card";

export const inject = ["lark"];

export interface Config {
  /** 增量更新最小间隔（默认 500ms）。 */
  throttleIntervalMs?: number;
  /** 增量合并字节阈值（默认 1 KiB）。 */
  throttleBytes?: number;
  /** 单卡正文字节上限（默认 32 KiB）。 */
  maxCardBytes?: number;
  /** 投递重试上限（默认 3 次，指数退避）。 */
  maxRetries?: number;
}

export const Config: z<Config> = z.object({
  throttleIntervalMs: z.number(),
  throttleBytes: z.number(),
  maxCardBytes: z.number(),
  maxRetries: z.number(),
});

/** 卡片投递服务契约（SPEC lark-card.md §2 投递面）。 */
export interface LarkCardService {
  /** 发送处理卡；返回 messageId（后续增量/终态的目标）。 */
  sendProcessing(chatId: ChatId): Promise<MessageId>;
  /** 节流追加增量 markdown（按 messageId 分键缓冲）。 */
  append(messageId: MessageId, markdown: string): void;
  /** 终态替换：flush 剩余增量 + 整卡替换（有界重试）。 */
  replace(messageId: MessageId, markdown: string): Promise<void>;
  /** 失败卡替换（有界重试；与 replace 同语义）。 */
  fail(messageId: MessageId, markdown: string): Promise<void>;
  /** 丢弃某卡的未投递增量缓冲（如 LARK_PERMISSION_DENIED 停更）。 */
  discard(messageId: MessageId): void;
}

export function apply(ctx: Context, config: Config): void {
  const lark = ctx.lark!;
  const throttles = new Map<string, CardThrottle>();
  const pendingUpdates = new Map<string, Promise<void>>();
  const { throttleIntervalMs: intervalMs, throttleBytes: bytes, maxCardBytes, maxRetries } = resolveCardConfig(config);

  /** 有界重试投递：限流/网络退避重试，超界放弃并告警（终态已尽力）。 */
  const deliverWithRetry = async (deliver: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await deliver();
        return;
      } catch {
        if (attempt >= maxRetries) {
          ctx.logger.warn(`lark-card: 投递重试耗尽（${maxRetries} 次）`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }
  };

  /** 同一卡片的更新严格串行，避免迟到增量覆盖终态。 */
  const queueUpdate = (messageId: MessageId, markdown: string, kind: "append" | "replace"): Promise<void> => {
    const previous = pendingUpdates.get(messageId) ?? Promise.resolve();
    const next = previous.then(() => deliverWithRetry(async () => {
      const card = renderMarkdownCard(markdown);
      const startedAt = Date.now();
      await lark.updateMessage(messageId, { kind: "markdown-card", card });
      ctx.logger?.info?.(`lark-card: update kind=${kind} message=${messageId} ${Date.now() - startedAt}ms`);
    }));
    pendingUpdates.set(messageId, next);
    return next;
  };

  ctx.provide("larkCard", {
    async sendProcessing(chatId) {
      const card = renderMarkdownCard("正在思考…");
      const startedAt = Date.now();
      const messageId = await lark.sendMessage(chatId, { kind: "markdown-card", card });
      ctx.logger?.info?.(`lark-card: send kind=processing message=${messageId} ${Date.now() - startedAt}ms`);
      return messageId;
    },

    append(messageId, markdown) {
      let throttle = throttles.get(messageId);
      if (!throttle) {
        throttle = new CardThrottle({
          intervalMs,
          bytes,
          maxCardBytes,
          flush: (text) => {
            void queueUpdate(messageId, text, "append");
          },
        });
        throttles.set(messageId, throttle);
      }
      throttle.push(markdown);
    },

    async replace(messageId, markdown) {
      throttles.get(messageId)?.flush();
      throttles.delete(messageId);
      await pendingUpdates.get(messageId);
      const terminal = queueUpdate(messageId, markdown, "replace");
      await terminal;
      if (pendingUpdates.get(messageId) === terminal) pendingUpdates.delete(messageId);
    },

    async fail(messageId, markdown) {
      await this.replace(messageId, markdown);
    },

    discard(messageId) {
      throttles.get(messageId)?.dispose();
      throttles.delete(messageId);
    },
  } satisfies LarkCardService);

  // 关停：丢弃全部未投递增量（pending 定时器取消，不再触发投递与日志）。
  ctx.effect(() => () => {
    for (const throttle of throttles.values()) throttle.dispose();
    throttles.clear();
    pendingUpdates.clear();
  });
}

// 供 gateway 编排使用的纯函数面。
export * from "./render.js";
export { CardThrottle } from "./throttle.js";
export type { LarkApi };
