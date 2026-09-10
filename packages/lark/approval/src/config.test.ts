import { describe, expect, it } from "vitest";

import { resolveApprovalConfig } from "./config.js";

describe("lark-approval 配置边界", () => {
  it("只在字段缺省时使用文档默认值", () => {
    expect(resolveApprovalConfig({})).toEqual({
      ttlMs: 30 * 60_000,
      maxOptions: 4,
      maxPendingPerScope: 5,
    });
  });

  it("保留声明范围内的显式值", () => {
    expect(resolveApprovalConfig({
      ttlMs: 1_000,
      maxOptions: 20,
      maxPendingPerScope: 100,
    })).toEqual({
      ttlMs: 1_000,
      maxOptions: 20,
      maxPendingPerScope: 100,
    });
  });

  it.each([
    [{ ttlMs: 0 }, "ttlMs"],
    [{ ttlMs: 1.5 }, "ttlMs"],
    [{ ttlMs: 24 * 60 * 60 * 1_000 + 1 }, "ttlMs"],
    [{ maxOptions: 0 }, "maxOptions"],
    [{ maxOptions: 21 }, "maxOptions"],
    [{ maxPendingPerScope: 0 }, "maxPendingPerScope"],
    [{ maxPendingPerScope: 101 }, "maxPendingPerScope"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveApprovalConfig(config)).toThrow(field);
  });
});
