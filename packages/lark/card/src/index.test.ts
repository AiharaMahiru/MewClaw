/**
 * dsh-lark-card 插件接线测试（SPEC lark-card.md §8）：
 * mock ctx.lark，覆盖处理卡发送、节流投递、终态替换与有界重试。
 */
import { describe, expect, it, vi } from "vitest";

import { makeChatId, makeMessageId } from "dsh-lark-contracts";

import { apply, type LarkCardService } from "./index.js";

function makeCtx() {
  const lark = {
    sendMessage: vi.fn(async (_chatId?: unknown, _content?: unknown) => makeMessageId("om_processing")),
    updateMessage: vi.fn(async (_messageId?: unknown, _content?: unknown) => undefined),
  };
  const provided: Record<string, unknown> = {};
  const ctx = {
    lark,
    logger: { warn: vi.fn() },
    provide: vi.fn((key: string, value: unknown) => {
      provided[key] = value;
    }),
    effect: vi.fn(() => () => undefined),
  };
  return { ctx, lark, provided };
}

const config = { throttleIntervalMs: 500, throttleBytes: 1024, maxCardBytes: 4096, maxRetries: 2 };

describe("lark-card 插件", () => {
  it("sendProcessing 发处理卡并返回 messageId", async () => {
    const { ctx, lark } = makeCtx();
    apply(ctx as never, config);
    const service = ctx.provide.mock.calls[0]![1] as LarkCardService;
    const messageId = await service.sendProcessing(makeChatId("oc_1"));
    expect(messageId).toBe("om_processing");
    expect(lark.sendMessage).toHaveBeenCalledWith("oc_1", expect.objectContaining({ kind: "markdown-card" }));
  });

  it("replace 终态替换（flush 未投递增量后整卡替换）", async () => {
    const { ctx, lark } = makeCtx();
    apply(ctx as never, config);
    const service = ctx.provide.mock.calls[0]![1] as LarkCardService;
    const messageId = makeMessageId("om_1");
    service.append(messageId, "增量内容");
    await service.replace(messageId, "终态内容");
    // 一次增量投递 + 一次终态替换（增量先 flush）。
    expect(lark.updateMessage).toHaveBeenCalledTimes(2);
    const calls = lark.updateMessage.mock.calls.map((call) => {
      const content = call[1] as { card: { body: { elements: Array<{ content?: string }> } } };
      return content.card.body.elements[0]?.content;
    });
    expect(calls).toEqual(["增量内容", "终态内容"]);
  });

  it("终态替换等待已 flush 的增量完成，避免旧内容覆盖终态", async () => {
    const { ctx, lark } = makeCtx();
    apply(ctx as never, config);
    const service = ctx.provide.mock.calls[0]![1] as LarkCardService;
    const messageId = makeMessageId("om_1");
    const delivered: string[] = [];
    let releaseIncrement!: () => void;
    const increment = new Promise<void>((resolve) => { releaseIncrement = resolve; });
    lark.updateMessage.mockImplementation(async (_messageId: unknown, content: unknown) => {
      const card = content as { card: { body: { elements: Array<{ content?: string }> } } };
      const text = card.card.body.elements[0]?.content ?? "";
      if (text === "增量内容") await increment;
      delivered.push(text);
    });

    service.append(messageId, "增量内容");
    const replacing = service.replace(messageId, "终态内容");
    const status = await Promise.race([
      replacing.then(() => "replaced"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
    ]);

    expect(status).toBe("pending");
    releaseIncrement();
    await replacing;
    expect(delivered).toEqual(["增量内容", "终态内容"]);
  });

  it("投递失败有界重试后放弃（告警记录）", async () => {
    const { ctx, lark } = makeCtx();
    apply(ctx as never, config);
    const service = ctx.provide.mock.calls[0]![1] as LarkCardService;
    lark.updateMessage.mockRejectedValue(new Error("rate limited"));
    await service.replace(makeMessageId("om_1"), "终态");
    // maxRetries=2 → 首投 + 2 重试 = 3 次。
    expect(lark.updateMessage).toHaveBeenCalledTimes(3);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });

  it("discard 清理缓冲（不再投递）", async () => {
    const { ctx, lark } = makeCtx();
    apply(ctx as never, config);
    const service = ctx.provide.mock.calls[0]![1] as LarkCardService;
    const messageId = makeMessageId("om_1");
    service.append(messageId, "将被丢弃");
    service.discard(messageId);
    expect(lark.updateMessage).not.toHaveBeenCalled();
    service.append(messageId, "新内容");
    await new Promise((resolve) => setTimeout(resolve, 600));
    // discard 后新 append 建立新缓冲并最终投递。
    expect(lark.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("非法节流配置在服务注册前 fail loud", () => {
    const { ctx } = makeCtx();
    expect(() => apply(ctx as never, { ...config, throttleBytes: 0 })).toThrow(/throttleBytes/);
    expect(ctx.provide).not.toHaveBeenCalled();
  });
});
