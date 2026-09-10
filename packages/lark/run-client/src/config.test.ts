import { describe, expect, it } from "vitest";

import { resolveRunClientConfig } from "./config.js";

describe("lark-run-client 配置边界", () => {
  it("使用文档默认值并保留流与 JSON 响应预算", () => {
    expect(resolveRunClientConfig({})).toEqual({
      connectTimeoutMs: 30_000,
      heartbeatToleranceMs: 45_000,
      maxEventBytes: 64 * 1024,
      maxResponseBytes: 32 * 1024 * 1024,
    });
    expect(resolveRunClientConfig({
      connectTimeoutMs: 1_000,
      heartbeatToleranceMs: 300_000,
      maxEventBytes: 1024 * 1024,
      maxResponseBytes: 32 * 1024 * 1024,
    })).toEqual({
      connectTimeoutMs: 1_000,
      heartbeatToleranceMs: 300_000,
      maxEventBytes: 1024 * 1024,
      maxResponseBytes: 32 * 1024 * 1024,
    });
  });

  it.each([
    [{ connectTimeoutMs: 0 }, "connectTimeoutMs"],
    [{ connectTimeoutMs: 300_001 }, "connectTimeoutMs"],
    [{ heartbeatToleranceMs: 0 }, "heartbeatToleranceMs"],
    [{ maxEventBytes: 0 }, "maxEventBytes"],
    [{ maxEventBytes: 1024 * 1024 + 1 }, "maxEventBytes"],
    [{ maxEventBytes: 1.5 }, "maxEventBytes"],
    [{ maxResponseBytes: 0 }, "maxResponseBytes"],
    [{ maxResponseBytes: 32 * 1024 * 1024 + 1 }, "maxResponseBytes"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveRunClientConfig(config)).toThrow(field);
  });
});
