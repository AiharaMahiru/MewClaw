/**
 * createLarkWs 测试（SPEC lark-ws.md §8）：mock 官方 SDK，
 * 覆盖帧解析（文本/撤回/卡片/菜单）、畸形帧计数、toast 返回与生命周期接线。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLarkWs, type LarkWsHandlers, type LarkWsLifecycle } from "./client.js";

const sdk = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown) => unknown>,
  clientConfig: undefined as unknown,
  start: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@larksuiteoapi/node-sdk", () => ({
  WSClient: class {
    constructor(config: unknown) {
      sdk.clientConfig = config as never;
    }
    start() {
      return sdk.start();
    }
    close(options: unknown) { sdk.close(options); }
  },
  EventDispatcher: class {
    register(handlers: Record<string, (event: unknown) => unknown>) {
      sdk.handlers = handlers;
      return this;
    }
  },
}));

type MockHandler<Handler extends (...args: never[]) => unknown> = Handler & ReturnType<typeof vi.fn>;
type MockLarkWsHandlers = {
  [Key in keyof LarkWsHandlers]: MockHandler<LarkWsHandlers[Key]>;
};

function mockHandler<Handler extends (...args: never[]) => unknown>(): MockHandler<Handler> {
  return vi.fn() as MockHandler<Handler>;
}

function makeHandlers(): MockLarkWsHandlers {
  return {
    onMessage: mockHandler(),
    onRecalled: mockHandler(),
    onCardAction: mockHandler(),
    onBotMenu: mockHandler(),
    onParseFailure: mockHandler(),
  };
}

function makeLifecycle(): LarkWsLifecycle {
  return {
    onReady: vi.fn(),
    onReconnected: vi.fn(),
    onReconnecting: vi.fn(),
    onError: vi.fn(),
  };
}

const options = () => ({
  appId: "cli_x",
  appSecret: "secret",
  domain: "feishu.cn",
  handlers: makeHandlers(),
  lifecycle: makeLifecycle(),
});

beforeEach(() => {
  // resetAllMocks：连实现一起清，避免 mockRejectedValue 泄漏到后续用例。
  vi.resetAllMocks();
  sdk.start.mockResolvedValue(undefined);
});

describe("start", () => {
  it("停止时实际关闭SDK并禁用重连", async () => {
    const ws = createLarkWs(options()); await ws.start(); ws.stop();
    expect(sdk.close).toHaveBeenCalledWith({ force: true });
  });
  it("构造 WSClient（含域名与握手超时）并启动", async () => {
    const ws = createLarkWs(options());
    await ws.start();
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(sdk.clientConfig).toMatchObject({ appId: "cli_x", appSecret: "secret", domain: "feishu.cn", handshakeTimeoutMs: 15_000 });
  });

  it("start 失败向上传播（插件层 fail loud）", async () => {
    sdk.start.mockRejectedValue(new Error("handshake failed"));
    const ws = createLarkWs(options());
    await expect(ws.start()).rejects.toThrow("handshake failed");
  });
});

describe("帧解析", () => {
  const booted = async () => {
    const built = options();
    const ws = createLarkWs(built);
    await ws.start();
    return built;
  };

  it("文本消息 → onMessage（结构解析 + 品牌化 ID）", async () => {
    const built = await booted();
    sdk.handlers["im.message.receive_v1"]!({
      event_id: "ev_1",
      sender: { sender_id: { open_id: "ou_1" } },
      message: { message_id: "om_1", chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }) },
    });
    expect(built.handlers.onMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "om_1", chatId: "oc_1", userId: "ou_1", delivery: "prompt", text: "你好",
    }));
  });

  it("畸形消息 → onParseFailure（不抛、不重连）", async () => {
    const built = await booted();
    sdk.handlers["im.message.receive_v1"]!({ event_id: "ev_2" });
    expect(built.handlers.onParseFailure).toHaveBeenCalledTimes(1);
    expect(built.handlers.onMessage).not.toHaveBeenCalled();
  });

  it("非法 event_id 回退到已校验的 messageId 去重键", async () => {
    const built = await booted();
    sdk.handlers["im.message.receive_v1"]!({
      event_id: "ev_\n1",
      sender: { sender_id: { open_id: "ou_1" } },
      message: { message_id: "om_1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "你好" }) },
    });
    expect(built.handlers.onMessage).toHaveBeenCalledWith(expect.objectContaining({ eventId: "om_1" }));
  });

  it("控制字符或超长平台 ID → onParseFailure", async () => {
    const built = await booted();
    const valid = {
      event_id: "ev_1",
      sender: { sender_id: { open_id: "ou_1" } },
      message: { message_id: "om_1", chat_id: "oc_1", message_type: "text", content: JSON.stringify({ text: "你好" }) },
    };
    for (const event of [
      { ...valid, message: { ...valid.message, message_id: "om_\n1" } },
      { ...valid, sender: { sender_id: { open_id: "ou_\n1" } } },
      { ...valid, message: { ...valid.message, chat_id: "c".repeat(257) } },
    ]) {
      sdk.handlers["im.message.receive_v1"]!(event);
    }
    sdk.handlers["im.message.recall_v1"]!({ message_id: "om_\n9" });
    sdk.handlers["application.bot.menu_v6"]!({
      event_id: "ev_menu",
      operator: { operator_id: { open_id: "ou_\n1" } },
      event_key: "menu.key",
    });

    expect(built.handlers.onParseFailure).toHaveBeenCalledTimes(5);
    expect(built.handlers.onMessage).not.toHaveBeenCalled();
    expect(built.handlers.onRecalled).not.toHaveBeenCalled();
    expect(built.handlers.onBotMenu).not.toHaveBeenCalled();
  });

  it("撤回 → onRecalled", async () => {
    const built = await booted();
    sdk.handlers["im.message.recall_v1"]!({ message_id: "om_9" });
    expect(built.handlers.onRecalled).toHaveBeenCalledWith("om_9");
  });

  it("合法卡片回调 → onCardAction 且返回空 toast；非法 → onParseFailure + 错误 toast", async () => {
    const built = await booted();
    const ok = sdk.handlers["card.action.trigger"]!({
      open_message_id: "om_1",
      open_chat_id: "oc_1",
      operator: { open_id: "ou_1" },
      action: { value: { actionId: "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c" } },
    });
    expect(ok).toEqual({});
    expect(built.handlers.onCardAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c" }));

    const bad = sdk.handlers["card.action.trigger"]!({ action: {} });
    expect(bad).toEqual({ toast: { type: "error", content: "操作无效，请刷新后重试" } });
    expect(built.handlers.onParseFailure).toHaveBeenCalled();
  });

  it("卡片回调消费异常不会传播到 SDK dispatcher", async () => {
    const built = await booted();
    built.handlers.onCardAction.mockImplementationOnce(() => {
      throw new Error("handler failed");
    });

    expect(() => sdk.handlers["card.action.trigger"]!({
      open_message_id: "om_1",
      open_chat_id: "oc_1",
      operator: { open_id: "ou_1" },
      action: { value: { actionId: "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c" } },
    })).not.toThrow();
    expect(built.handlers.onParseFailure).toHaveBeenCalledTimes(1);
  });

  it("机器人菜单 → onBotMenu", async () => {
    const built = await booted();
    sdk.handlers["application.bot.menu_v6"]!({
      event_id: "ev_menu",
      operator: { operator_id: { open_id: "ou_1" } },
      event_key: "menu.key",
    });
    expect(built.handlers.onBotMenu).toHaveBeenCalledWith({ eventId: "ev_menu", userId: "ou_1", eventKey: "menu.key" });
  });

  it("生命周期回调逐一接到 SDK", async () => {
    const built = options();
    const ws = createLarkWs(built);
    await ws.start();
    const cfg = sdk.clientConfig as { onReady: () => void; onReconnected: () => void; onReconnecting: () => void; onError: () => void };
    cfg.onReady();
    cfg.onReconnected();
    cfg.onReconnecting();
    cfg.onError();
    expect(built.lifecycle.onReady).toHaveBeenCalledTimes(1);
    expect(built.lifecycle.onReconnected).toHaveBeenCalledTimes(1);
    expect(built.lifecycle.onReconnecting).toHaveBeenCalledTimes(1);
    expect(built.lifecycle.onError).toHaveBeenCalledTimes(1);
  });
});
