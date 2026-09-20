import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";

import { apply } from "./index.js";

describe("DeepSeek 逻辑模型路由", () => {
  it("默认把 V4.1 Flash 映射为 commandcode wire ID", async () => {
    let body: { model?: string } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted({ models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }] });
    try {
      const prepared = await ctx.llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4.1-flash" });
      for await (const chunk of prepared.stream({ ...options(), ...prepared.config })) void chunk;
      expect(body?.model).toBe("deepseek/deepseek-v4.1-flash");
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });

  it("Settings 提供空别名字典时仍保留必需 wire 映射", async () => {
    let body: { model?: string } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted({
      models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
      modelAliases: {},
      disabledModels: [],
    });
    try {
      const prepared = await ctx.llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4.1-flash" });
      for await (const chunk of prepared.stream({ ...options(), ...prepared.config })) void chunk;
      expect(body?.model).toBe("deepseek/deepseek-v4.1-flash");
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });

  it("目录只公开 V4.1 Flash", async () => {
    const ctx = await mounted({ models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }], modelAliases: { "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash" }, disabledModels: [] });
    try {
      const models = await ctx.llm.listModels("deepseek-official");
      expect(models).toEqual([expect.objectContaining({ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" })]);
    } finally { await ctx.fiber.dispose(); }
  });

  it("请求序列化使用 wire model，返回的模型身份仍为逻辑 ID", async () => {
    let body: { model?: string } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted({ models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }], modelAliases: { "deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash" }, disabledModels: [] });
    try {
      const prepared = await ctx.llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4.1-flash" });
      expect(prepared.config.model).toBe("deepseek-v4.1-flash");
      for await (const chunk of prepared.stream({ ...options(), ...prepared.config })) void chunk;
      expect(body?.model).toBe("deepseek/deepseek-v4.1-flash");
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });

  it("prepared stream 投影掉 user/tool-result 中 DeepSeek 不支持的 reasoning", async () => {
    let body: { messages?: Array<{ role: string; content: Array<{ type: string; content?: Array<{ type: string }> }> }> } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted();
    try {
      const prepared = await ctx.llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" });
      for await (const chunk of prepared.stream({ ...options(), ...prepared.config, messages: unsupportedHistory() })) void chunk;
      expect(body?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "thinking" })]) }),
        expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", content: [expect.objectContaining({ type: "text" })] })]) }),
      ]));
      expect(JSON.stringify(body?.messages)).not.toContain("bad user reasoning");
      expect(JSON.stringify(body?.messages)).not.toContain("bad tool reasoning");
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });

  it("direct stream 同样在 provider 边界清理 user reasoning", async () => {
    let body: { messages?: unknown } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted();
    try {
      for await (const chunk of ctx.llm.stream({ ...options(), messages: unsupportedHistory() })) void chunk;
      expect(JSON.stringify(body?.messages)).not.toContain("bad user reasoning");
      expect(JSON.stringify(body?.messages)).not.toContain("bad tool reasoning");
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });

  it("直接指定被隐藏模型时在网络请求前拒绝", async () => {
    const request = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", request);
    const ctx = await mounted();
    try {
      await expect(ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4-flash-vision-exp")).rejects.toMatchObject({ code: "MODEL_DISABLED" });
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await ctx.fiber.dispose();
    }
  });
});

async function mounted(config: Parameters<typeof apply>[1] = {}): Promise<Context> {
  const ctx = new Context();
  new LlmRuntime(ctx);
  ctx.provide("credentials", { resolve: async () => ({ value: "test-key", source: "test" }) } as never);
  ctx.plugin(apply, { baseURL: "https://api.deepseek.test", apiKeyEnv: "DEEPSEEK_TEST_KEY", ...config });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return ctx;
}

function options(): GenerateOptions {
  return { provider: "deepseek-official", model: "deepseek-v4-flash", messages: [] };
}

function unsupportedHistory(): GenerateOptions["messages"] {
  const callId = "call-1" as never;
  return [
    { id: "assistant-1", role: "assistant", content: [{ type: "reasoning", text: "keep assistant reasoning" }, { type: "tool-call", id: callId, name: "lookup", arguments: "{}" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } },
    { id: "tool-1", role: "user", content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "tool output" }, { type: "reasoning", text: "bad tool reasoning" }] }], source: { kind: "tool", callId } },
    { id: "user-1", role: "user", content: [{ type: "reasoning", text: "bad user reasoning" }, { type: "text", text: "continue" }], source: { kind: "user" } },
  ] as never;
}
