import { rmSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeChatId,
  makeMessageId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import type { GatewayCommandResult, ParsedGatewayCommand } from "dsh-lark-commands";
import type { InboundMessage, LarkBotMenuEvent } from "dsh-lark-ws";

import { apply } from "./index.js";

const STATE_DIR = "var/test-gateway-menu-state";
const UPLOADS_ROOT = "var/test-gateway-menu-uploads";
const config = {
  authorizedOpenIds: ["ou_1"],
  allowedChatIds: [] as string[],
  processingCardText: "正在思考...",
  failureCardTemplate: "运行失败（{{code}}）：{{hint}}",
  stateDir: STATE_DIR,
  tenantId: "t",
  botId: "b",
  deploymentId: "d",
  uploadsRoot: UPLOADS_ROOT,
  cronPollIntervalMs: 0,
};

beforeEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(UPLOADS_ROOT, { recursive: true, force: true });
});

function commandForMenu(eventKey: string): ParsedGatewayCommand | undefined {
  if (eventKey === "help") return { name: "help", args: "" };
  return undefined;
}

function makeEnv() {
  const listeners = new Map<string, Array<(payload: never) => void>>();
  const lark = {
    sendMessage: vi.fn(async () => makeMessageId("om_card")),
    sendMessageToUser: vi.fn(async () => ({
      messageId: makeMessageId("om_menu"),
      chatId: makeChatId("oc_user"),
    })),
    updateMessage: vi.fn(async () => undefined),
    uploadImage: vi.fn(),
    downloadResource: vi.fn(),
  };
  const commands = {
    parse: vi.fn((text: string) => text === "/help" ? { name: "help", args: "" } : undefined),
    resolveBotMenu: vi.fn(commandForMenu),
    handle: vi.fn(async (
      _input: { scope: Scope; command: ParsedGatewayCommand },
    ): Promise<GatewayCommandResult> => ({ markdown: "帮助" })),
    handleCardAction: vi.fn(),
    getProfile: vi.fn(() => "standard" as const),
  };
  const runClient = {
    submit: vi.fn(), readArtifact: vi.fn(), cancel: vi.fn(), resolveInteraction: vi.fn(),
  };
  const ctx = {
    lark,
    larkRunClient: runClient,
    larkCommands: commands,
    larkCard: {
      sendProcessing: vi.fn(), append: vi.fn(), replace: vi.fn(), fail: vi.fn(), discard: vi.fn(),
    },
    on: vi.fn((event: string, handler: (payload: never) => void) => {
      const registered = listeners.get(event) ?? [];
      registered.push(handler);
      listeners.set(event, registered);
      return () => undefined;
    }),
    effect: vi.fn(() => () => undefined),
    logger: { warn: vi.fn() },
  };
  return {
    ctx,
    lark,
    commands,
    runClient,
    emit(event: string, payload: unknown) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload as never);
    },
  };
}

function menu(overrides: Partial<LarkBotMenuEvent> = {}): LarkBotMenuEvent {
  return {
    eventId: overrides.eventId ?? "ev_menu",
    userId: overrides.userId ?? makeUserId("ou_1"),
    eventKey: overrides.eventKey ?? "help",
  };
}

function p2pMessage(): InboundMessage {
  return {
    eventId: "ev_message",
    messageId: makeMessageId("om_input"),
    userId: makeUserId("ou_1"),
    chatId: makeChatId("oc_allowed"),
    chatType: "p2p",
    delivery: "prompt",
    text: "/help",
    resources: [],
  };
}

describe("机器人菜单命令链", () => {
  it("首次点击用平台返回的 chatId 构造 Scope，并按 eventId 去重", async () => {
    const env = makeEnv();
    apply(env.ctx as never, config);

    env.emit("lark/bot/menu", menu());
    env.emit("lark/bot/menu", menu());

    await vi.waitFor(() => expect(env.lark.updateMessage).toHaveBeenCalledTimes(1));
    expect(env.lark.sendMessageToUser).toHaveBeenCalledTimes(1);
    expect(env.commands.handle).toHaveBeenCalledTimes(1);
    const input = env.commands.handle.mock.calls[0]![0];
    expect(input.scope).toMatchObject({ userId: "ou_1", conversationId: "oc_user" });
    expect(input.command).toEqual({ name: "help", args: "" });
    expect(env.runClient.submit).not.toHaveBeenCalled();
  });

  it("未授权用户、未知 eventKey 与受限未知 chat 均不产生副作用", async () => {
    const unauthorized = makeEnv();
    apply(unauthorized.ctx as never, config);
    unauthorized.emit("lark/bot/menu", menu({ userId: makeUserId("ou_other") }));
    unauthorized.emit("lark/bot/menu", menu({ eventId: "ev_unknown", eventKey: "unknown" }));

    const restricted = makeEnv();
    apply(restricted.ctx as never, { ...config, allowedChatIds: ["oc_allowed"] });
    restricted.emit("lark/bot/menu", menu());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(unauthorized.lark.sendMessageToUser).not.toHaveBeenCalled();
    expect(unauthorized.commands.handle).not.toHaveBeenCalled();
    expect(restricted.lark.sendMessageToUser).not.toHaveBeenCalled();
    expect(restricted.commands.handle).not.toHaveBeenCalled();
  });

  it("受限部署复用已授权 P2P chat，仍走同一 commands.handle", async () => {
    const env = makeEnv();
    apply(env.ctx as never, { ...config, allowedChatIds: ["oc_allowed"] });
    env.emit("lark/message/received", p2pMessage());
    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalledTimes(1));
    env.lark.sendMessage.mockClear();
    env.commands.handle.mockClear();

    env.emit("lark/bot/menu", menu({ eventId: "ev_after_message" }));

    await vi.waitFor(() => expect(env.lark.sendMessage).toHaveBeenCalledTimes(1));
    expect(env.lark.sendMessage).toHaveBeenCalledWith("oc_allowed", expect.anything());
    expect(env.lark.sendMessageToUser).not.toHaveBeenCalled();
    expect(env.commands.handle).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({ conversationId: "oc_allowed" }),
      command: { name: "help", args: "" },
    }));
  });
});
