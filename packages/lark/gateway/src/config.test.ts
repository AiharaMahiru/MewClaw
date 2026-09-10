import { describe, expect, it } from "vitest";

import { resolveGatewayRuntimeConfig, type Config } from "./config.js";

const input: Config = {
  authorizedOpenIds: ["ou_1"],
  allowedChatIds: [],
  processingCardText: "处理中",
  failureCardTemplate: "失败",
  uploadsRoot: "var/uploads",
};

describe("lark-gateway 运行时配置边界", () => {
  it("缺省使用有界默认，零仅用于显式关闭 cron 轮询", () => {
    expect(resolveGatewayRuntimeConfig(input)).toEqual({
      stateDir: "var/gateway",
      dedupTtlMs: 10 * 60_000,
      dedupMaxEntries: 100_000,
      maxToolLines: 8,
      cronPollIntervalMs: 15_000,
    });
    expect(resolveGatewayRuntimeConfig({ ...input, cronPollIntervalMs: 0 }).cronPollIntervalMs).toBe(0);
  });

  it.each([
    [{ dedupTtlMs: 0 }, "dedupTtlMs"],
    [{ dedupMaxEntries: 0 }, "dedupMaxEntries"],
    [{ maxToolLines: 0 }, "maxToolLines"],
    [{ cronPollIntervalMs: -1 }, "cronPollIntervalMs"],
    [{ cronPollIntervalMs: 1.5 }, "cronPollIntervalMs"],
    [{ stateDir: "  " }, "stateDir"],
  ])("拒绝非法配置 %o", (override, field) => {
    expect(() => resolveGatewayRuntimeConfig({ ...input, ...override })).toThrow(field);
  });
});
