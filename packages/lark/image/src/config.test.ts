import { describe, expect, it } from "vitest";

import { resolveImageConfig } from "./config.js";

describe("lark-image 配置边界", () => {
  it("使用参考图默认预算并允许上界", () => {
    expect(resolveImageConfig({})).toEqual({
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com",
      maxReferenceBytes: 10 * 1024 * 1024,
      maxReferences: 8,
      model: "gpt-image-2",
    });
    expect(resolveImageConfig({ maxReferenceBytes: 50 * 1024 * 1024, maxReferences: 16 }))
      .toMatchObject({ maxReferenceBytes: 50 * 1024 * 1024, maxReferences: 16 });
  });

  it("允许显式 OpenAI 配置并拒绝聊天模型或带凭证 URL", () => {
    expect(resolveImageConfig({
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1/",
      model: "gpt-image-1.5",
    })).toMatchObject({
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-image-1.5",
    });
    expect(() => resolveImageConfig({ model: "gpt-5.6" })).toThrow(/GPT Image/);
    expect(() => resolveImageConfig({ baseUrl: "https://key@example.com" })).toThrow(/without credentials/);
    expect(() => resolveImageConfig({ apiKeyEnv: "not a ref" })).toThrow(/credential reference/);
  });

  it.each([
    [{ maxReferenceBytes: 0 }, "maxReferenceBytes"],
    [{ maxReferenceBytes: 50 * 1024 * 1024 + 1 }, "maxReferenceBytes"],
    [{ maxReferences: 0 }, "maxReferences"],
    [{ maxReferences: 17 }, "maxReferences"],
    [{ maxReferences: 1.5 }, "maxReferences"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveImageConfig(config)).toThrow(field);
  });
});
