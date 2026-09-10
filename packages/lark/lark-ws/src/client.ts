/**
 * WebSocket 客户端封装（SPEC lark-ws.md）：官方 SDK 的 WSClient/EventDispatcher
 * 与本仓库类型化事件之间的唯一转换层。
 *
 * 本模块是纯组合（无 cordis 依赖），插件入口只做凭证解析与事件接线；
 * 测试直接以 mock SDK 驱动本模块。
 */
import { EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { parseCardAction, type CardActionPayload } from "dsh-lark";
import { parseMessageId, type MessageId } from "dsh-lark-contracts";

import { parseLarkBotMenuEvent, type LarkBotMenuEvent } from "./bot-menu.js";
import type { InboundMessage } from "./events.js";
import { parseLarkInboundMessage } from "./inbound-message.js";

/** 入站事件处理回调（由插件接到 ctx.emit）。 */
export interface LarkWsHandlers {
  onMessage(message: InboundMessage): void;
  onRecalled(messageId: MessageId): void;
  onCardAction(payload: CardActionPayload): void;
  onBotMenu(menu: LarkBotMenuEvent): void;
  /** 畸形帧（结构解析失败）——仅计数用。 */
  onParseFailure(): void;
}

/** 连接生命周期回调（由插件接到 lark/connection 事件）。 */
export interface LarkWsLifecycle {
  onReady(): void;
  onReconnected(): void;
  onReconnecting(): void;
  onError(): void;
}

export interface LarkWsOptions {
  appId: string;
  appSecret: string;
  /** 飞书域名（feishu.cn / larksuite.com）；缺省走 SDK 默认。 */
  domain?: string;
  handlers: LarkWsHandlers;
  lifecycle: LarkWsLifecycle;
}

export interface LarkWsClient {
  /** 建立长连接；失败 reject（插件层 fail loud）。 */
  start(): Promise<void>;
  /** 关停连接并清理SDK重连定时器。 */
  stop(): void;
}

/** 事件回调统一兜底：畸形帧只计数不重连（SPEC lark-ws.md §6）。 */
function guard<T>(handlers: LarkWsHandlers, run: () => T): T | undefined {
  try {
    return run();
  } catch {
    handlers.onParseFailure();
    return undefined;
  }
}

export function createLarkWs(options: LarkWsOptions): LarkWsClient {
  let client: WSClient | undefined;

  const dispatcher = new EventDispatcher({}).register({
    "im.message.receive_v1": (raw: unknown) => {
      guard(options.handlers, () => {
        const message = parseLarkInboundMessage(raw);
        if (message) options.handlers.onMessage(message);
        else options.handlers.onParseFailure();
      });
    },
    "im.message.recall_v1": (raw: unknown) => {
      guard(options.handlers, () => {
        const source = raw as { message_id?: unknown } | undefined;
        const messageId = parseMessageId(source?.message_id);
        if (messageId.ok) {
          options.handlers.onRecalled(messageId.value);
        } else {
          options.handlers.onParseFailure();
        }
      });
    },
    "card.action.trigger": (raw: unknown) => {
      const result = guard(options.handlers, () => {
        const parsed = parseCardAction(raw);
        if (!parsed.ok) {
          options.handlers.onParseFailure();
          // 与 lark-claw 语义一致：无效卡片回调给操作者一个 toast 提示。
          return { toast: { type: "error", content: "操作无效，请刷新后重试" } };
        }
        options.handlers.onCardAction(parsed.value);
        return {};
      });
      return result ?? { toast: { type: "error", content: "操作无效，请刷新后重试" } };
    },
    "application.bot.menu_v6": (raw: unknown) => {
      guard(options.handlers, () => {
        const menu = parseLarkBotMenuEvent(raw);
        if (menu) options.handlers.onBotMenu(menu);
        else options.handlers.onParseFailure();
      });
    },
  });

  return {
    async start() {
      client = new WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        ...(options.domain ? { domain: options.domain } : {}),
        handshakeTimeoutMs: 15_000,
        onReady: options.lifecycle.onReady,
        onReconnected: options.lifecycle.onReconnected,
        onReconnecting: options.lifecycle.onReconnecting,
        onError: options.lifecycle.onError,
      });
      await client.start({ eventDispatcher: dispatcher });
    },
    stop() {
      client?.close({ force: true });
    },
  };
}
