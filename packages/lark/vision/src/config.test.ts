import { describe, expect, it } from "vitest";

import { resolveVisionConfig } from "./config.js";

describe("lark-vision 配置边界", () => {
  it("缺省使用 120 秒有限时限", () => {
    expect(resolveVisionConfig({})).toEqual({ timeoutMs: 120_000 });
  });

  it.each([0, 999, 300_001, 1.5, Number.MAX_SAFE_INTEGER + 1])("拒绝非法 timeoutMs=%s", (timeoutMs) => {
    expect(() => resolveVisionConfig({ timeoutMs })).toThrow("timeoutMs");
  });
});
