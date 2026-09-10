import { describe, expect, it } from "vitest";

import { resolveCronConfig } from "./config.js";

describe("cron runtime configuration", () => {
  it("uses documented defaults and preserves valid boundaries", () => {
    expect(resolveCronConfig({})).toEqual({
      pollIntervalMs: 10_000,
      leaseMs: 15 * 60_000,
      outboxLeaseMs: 5 * 60_000,
      batchSize: 10,
    });
    expect(resolveCronConfig({
      pollIntervalMs: 1_000,
      leaseMs: 3_000,
      outboxLeaseMs: 1_000,
      batchSize: 100,
    })).toEqual({ pollIntervalMs: 1_000, leaseMs: 3_000, outboxLeaseMs: 1_000, batchSize: 100 });
  });

  it("rejects zero, non-integer, and out-of-range configuration", () => {
    const invalid = [
      [{ pollIntervalMs: 0 }, "pollIntervalMs"],
      [{ pollIntervalMs: 3_600_001 }, "pollIntervalMs"],
      [{ leaseMs: 2_999 }, "leaseMs"],
      [{ leaseMs: 3.5 }, "leaseMs"],
      [{ outboxLeaseMs: -1 }, "outboxLeaseMs"],
      [{ outboxLeaseMs: Number.MAX_SAFE_INTEGER + 1 }, "outboxLeaseMs"],
      [{ batchSize: 0 }, "batchSize"],
      [{ batchSize: 101 }, "batchSize"],
    ] as const;

    for (const [config, field] of invalid) {
      expect(() => resolveCronConfig(config)).toThrow(new RegExp(field));
    }
  });
});
