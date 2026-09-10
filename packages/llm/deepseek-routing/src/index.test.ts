import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, type GenerateOptions } from "@deepseek-ai/dsh-llm";
import { describe, expect, it, vi } from "vitest";

import { apply } from "./index.js";

describe("DeepSeek 逻辑模型路由", () => {
  it("目录保留逻辑 Flash 名称并隐藏 Vision Exp", async () => {
    const ctx = await mounted();
    try {
      const models = await ctx.llm.listModels("deepseek-official");
      expect(models).toContainEqual(expect.objectContaining({ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }));
      expect(models.map((model) => model.id)).not.toContain("deepseek-v4-flash-vision-exp");
      expect(models.map((model) => model.id)).not.toContain("deepseek-v4.1-flash-expires-on-0910");
    } finally { await ctx.fiber.dispose(); }
  });

  it("请求序列化使用 wire model，返回的模型身份仍为逻辑 ID", async () => {
    let body: { model?: string } | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const ctx = await mounted();
    try {
      const prepared = await ctx.llm.prepareCall({ provider: "deepseek-official", model: "deepseek-v4-flash" });
      expect(prepared.config.model).toBe("deepseek-v4-flash");
      for await (const chunk of prepared.stream({ ...options(), ...prepared.config })) void chunk;
      expect(body?.model).toBe("deepseek-v4.1-flash-expires-on-0910");
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

async function mounted(): Promise<Context> {
  const ctx = new Context();
  new LlmRuntime(ctx);
  ctx.provide("credentials", { resolve: async () => ({ value: "test-key", source: "test" }) } as never);
  ctx.plugin(apply, { baseURL: "https://api.deepseek.test", apiKeyEnv: "DEEPSEEK_TEST_KEY" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return ctx;
}

function options(): GenerateOptions {
  return { provider: "deepseek-official", model: "deepseek-v4-flash", messages: [] };
}
