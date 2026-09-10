import { describe, expect, it } from "vitest";

import { resolveCardConfig } from "./config.js";

describe("lark-card 配置边界", () => {
  it("只在字段缺省时使用交付默认值", () => {
    expect(resolveCardConfig({})).toEqual({
      throttleIntervalMs: 500,
      throttleBytes: 1024,
      maxCardBytes: 32 * 1024,
      maxRetries: 3,
    });
  });

  it("保留允许范围内的显式值，包括零次重试", () => {
    expect(resolveCardConfig({
      throttleIntervalMs: 50,
      throttleBytes: 1,
      maxCardBytes: 1024,
      maxRetries: 0,
    })).toEqual({ throttleIntervalMs: 50, throttleBytes: 1, maxCardBytes: 1024, maxRetries: 0 });
  });

  it.each([
    [{ throttleIntervalMs: 0 }, "throttleIntervalMs"],
    [{ throttleBytes: 0 }, "throttleBytes"],
    [{ maxCardBytes: 0 }, "maxCardBytes"],
    [{ maxRetries: -1 }, "maxRetries"],
    [{ maxRetries: 6 }, "maxRetries"],
    [{ throttleBytes: 1025, maxCardBytes: 1024 }, "throttleBytes"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveCardConfig(config)).toThrow(field);
  });
});
