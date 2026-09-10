import { describe, expect, it } from "vitest";

import { resolveGatewayAttachmentLimits } from "./attachment-config.js";

describe("gateway 附件限制", () => {
  it("使用默认值并保留测试与部署需要的正值", () => {
    expect(resolveGatewayAttachmentLimits({})).toEqual({
      maxBytes: 100 * 1024 * 1024,
      ttlMs: 10 * 60_000,
      maxPending: 10,
    });
    expect(resolveGatewayAttachmentLimits({ maxBytes: 8, ttlMs: 50, maxPending: 2 }))
      .toEqual({ maxBytes: 8, ttlMs: 50, maxPending: 2 });
  });

  it.each([
    [{ maxBytes: 0 }, "maxBytes"],
    [{ maxBytes: 100 * 1024 * 1024 + 1 }, "maxBytes"],
    [{ ttlMs: 0 }, "ttlMs"],
    [{ ttlMs: 24 * 60 * 60 * 1_000 + 1 }, "ttlMs"],
    [{ maxPending: 0 }, "maxPending"],
    [{ maxPending: 101 }, "maxPending"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveGatewayAttachmentLimits(config)).toThrow(field);
  });
});
