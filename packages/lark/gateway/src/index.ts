/** 飞书消息与卡片回调的唯一授权、去重与运行协调面。 */
import type { Context } from "@deepseek-ai/cordis";
import { renderMarkdownCard } from "dsh-lark";
import type { LarkCardService } from "dsh-lark-card";
import type { LarkCommandsService } from "dsh-lark-commands";
import "dsh-lark-contracts/context";
import "dsh-lark-contracts/events";
import { makeChatId, scopeKey, type Scope } from "dsh-lark-contracts";
import type { LarkRunClient } from "dsh-lark-run-client";
import type { InboundMessage, LarkBotMenuEvent } from "dsh-lark-ws";
import type {} from "dsh-cdg-bridge";

import { GatewayAttachments } from "./attachments.js";
import {
  resolveGatewayRuntimeConfig,
  resolveGatewaySecurity,
  type Config as GatewayConfig,
  type GatewaySecurity,
} from "./config.js";
import { CronDeliveryPoller } from "./cron.js";
import { Dedupe } from "./dedupe.js";
import { GatewayHandlers } from "./gateway-handlers.js";
import { SessionGenerations } from "./generations.js";
import { RunFlow } from "./run-flow.js";

export const name = "lark-gateway";
export const inject = ["lark", "larkRunClient", "larkCard", "larkCommands", "cdgBridge"];
export { Config } from "./config.js";

interface PollerInput {
  ctx: Context;
  intervalMs: number;
  security: GatewaySecurity;
  runClient: LarkRunClient;
}

function registerCronPoller(input: PollerInput): void {
  const { ctx, intervalMs, security, runClient } = input;
  if (intervalMs <= 0) return;
  const poller = new CronDeliveryPoller(runClient, (chatId, markdown) => {
    return ctx.lark!.sendMessage(makeChatId(chatId), { kind: "markdown-card", card: renderMarkdownCard(markdown) });
  }, {
    identity: security.identity,
    authorizedOpenIds: security.authorizedOpenIds,
    reportInfo: (message) => ctx.logger?.info?.(message),
    reportError: (error: unknown) => {
      ctx.logger.warn(`lark-gateway: cron 投递失败（${error instanceof Error ? error.message : "unknown"}）`);
    },
  });
  const timer = setInterval(() => void poller.tick(), intervalMs);
  ctx.effect(() => () => clearInterval(timer));
}

export function apply(ctx: Context, config: GatewayConfig): void {
  const security = resolveGatewaySecurity(config);
  const runtime = resolveGatewayRuntimeConfig(config);
  const runClient = ctx.larkRunClient!;
  const commands = ctx.larkCommands!;
  const generations = new SessionGenerations(runtime.stateDir);
  const dedupe = new Dedupe({
    ttlMs: runtime.dedupTtlMs,
    maxEntries: runtime.dedupMaxEntries,
  });
  const attachments = new GatewayAttachments({
    uploadsRoot: config.uploadsRoot,
    maxBytes: config.maxAttachmentBytes,
    ttlMs: config.attachmentTtlMs,
    ...(ctx.cdgBridge ? { cdgBridge: ctx.cdgBridge } : {}),
  });
  const runFlow = new RunFlow({
    lark: ctx.lark!,
    runClient,
    card: ctx.larkCard!,
    commands,
    generations,
    maxToolLines: runtime.maxToolLines,
    failureCardTemplate: config.failureCardTemplate,
    info: (message) => ctx.logger?.info?.(message),
  });
  const handlers = new GatewayHandlers({
    lark: ctx.lark!,
    runClient,
    commands,
    security,
    ...(config.unauthorizedCardText === undefined ? {} : { unauthorizedCardText: config.unauthorizedCardText }),
    dedupe,
    generations,
    attachments,
    runFlow,
    info: (message) => ctx.logger?.info?.(message),
    warn: (message) => ctx.logger.warn(message),
  });
  const generationsReady = generations.load();
  const afterGenerationsReady = (handler: () => void): void => {
    void generationsReady.then(handler).catch(() => {
      ctx.logger.warn("lark-gateway: 会话代次状态加载失败");
    });
  };
  registerCronPoller({ ctx, intervalMs: runtime.cronPollIntervalMs, security, runClient });
  ctx.on("lark/message/received", (message: InboundMessage) => {
    afterGenerationsReady(() => handlers.message(message));
  });
  ctx.on("lark/card/action", (action) => {
    afterGenerationsReady(() => handlers.cardAction(action));
  });
  ctx.on("lark/bot/menu", (menu: LarkBotMenuEvent) => {
    afterGenerationsReady(() => handlers.botMenu(menu));
  });
  ctx.on("lark/message/recalled", () => undefined);
  ctx.on("lark/command/clear-session", (payload: { scope: Scope }) => {
    afterGenerationsReady(() => {
      void generations.bump(scopeKey(payload.scope)).catch(() => {
        ctx.logger.warn("lark-gateway: 会话代次持久化失败");
      });
    });
  });
  ctx.on("lark/run/stream/error", (payload) => {
    ctx.logger.warn(`lark-gateway: 运行流错误 ${payload.code}（run ${payload.runId}）`);
  });
}

export { Dedupe } from "./dedupe.js";
export { SessionGenerations } from "./generations.js";
export type { InboundMessage, LarkBotMenuEvent, LarkCardService, LarkCommandsService, LarkRunClient };
