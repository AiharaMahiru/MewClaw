import { describe, expect, it, vi } from "vitest";

import { appendRunInputs, boundedMemory, prepareRunPrompt } from "./run-prompt.js";

const options = {
  request: {
    scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: "u", conversationId: "c" },
    prompt: "用户问题",
    attachments: [],
  },
  memory: {
    recall: vi.fn(),
  },
};

const agent = { session: { append: vi.fn() } } as never;

describe("run prompt memory fallback", () => {
  it("在模型运行前落盘原始输入和 preset 身份", () => {
    const append = vi.fn();
    appendRunInputs({
      request: { ...options.request, messageId: "om_prompt" },
      preset: { name: "lark-standard", revision: "r1", version: "1.0.0", skills: ["lark-cron"] },
    } as never, { session: { append } } as never);

    expect(append).toHaveBeenNthCalledWith(1, "lark/message/in", {
      scope: options.request.scope,
      messageId: "om_prompt",
      text: "用户问题",
    });
    expect(append).toHaveBeenNthCalledWith(2, "lark/run/preset", {
      scope: options.request.scope,
      preset: "lark-standard",
      revision: "r1",
      version: "1.0.0",
      skills: ["lark-cron"],
    });
  });

  it("recall content enters prompt with a replayable count marker", async () => {
    const append = vi.fn();
    const result = await prepareRunPrompt({
      request: options.request,
      memory: { recall: vi.fn().mockResolvedValue([{ content: "历史偏好" }]) },
    } as never, { session: { append } } as never, "workspace");

    expect(result.prompt).toContain("历史偏好");
    expect(append).toHaveBeenCalledWith("lark/memory/recalled", {
      scope: options.request.scope,
      count: 1,
    });
  });

  it("recall failure leaves the original prompt", async () => {
    options.memory.recall.mockRejectedValue(new Error("memory unavailable"));
    const result = await prepareRunPrompt(options as never, agent, "workspace");
    expect(result).toEqual({ prompt: "用户问题" });
  });

  it("recall timeout leaves the original prompt", async () => {
    vi.useFakeTimers();
    try {
      options.memory.recall.mockReturnValue(new Promise(() => undefined));
      const pending = prepareRunPrompt(options as never, agent, "workspace");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ prompt: "用户问题" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("boundedMemory returns fallback on rejection", async () => {
    await expect(boundedMemory(Promise.reject(new Error("offline")), "fallback", 100)).resolves.toBe("fallback");
  });
});
