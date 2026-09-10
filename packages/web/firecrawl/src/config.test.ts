import { describe, expect, it } from "vitest";

import { resolveFirecrawlConfig } from "./config.js";

describe("web-firecrawl 配置边界", () => {
  it("缺省使用官方 API 与有界超时", () => {
    expect(resolveFirecrawlConfig({})).toEqual({
      apiUrl: "https://api.firecrawl.dev",
      timeoutMs: 60_000,
    });
  });

  it.each([
    [{ apiUrl: "  " }, "apiUrl"],
    [{ apiUrl: "ftp://api.example" }, "apiUrl"],
    [{ apiUrl: "https://user:pass@api.example" }, "apiUrl"],
    [{ timeoutMs: 0 }, "timeoutMs"],
    [{ timeoutMs: 300_001 }, "timeoutMs"],
    [{ timeoutMs: 1.5 }, "timeoutMs"],
  ])("拒绝非法配置 %o", (input, field) => {
    expect(() => resolveFirecrawlConfig(input)).toThrow(field);
  });
});
