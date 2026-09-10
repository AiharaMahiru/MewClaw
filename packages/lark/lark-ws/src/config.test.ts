import { describe, expect, it } from "vitest";

import { resolveLarkWsConfig } from "./config.js";

describe("lark-ws 配置边界", () => {
  it("使用文档默认值并保留边界内显式值", () => {
    expect(resolveLarkWsConfig({})).toEqual({ failureWindowMs: 300_000, healthPublishIntervalMs: 30_000 });
    expect(resolveLarkWsConfig({ failureWindowMs: 1_000, healthPublishIntervalMs: 3_600_000 }))
      .toEqual({ failureWindowMs: 1_000, healthPublishIntervalMs: 3_600_000 });
  });

  it.each([
    [{ failureWindowMs: 0 }, "failureWindowMs"],
    [{ failureWindowMs: 86_400_001 }, "failureWindowMs"],
    [{ healthPublishIntervalMs: 0 }, "healthPublishIntervalMs"],
    [{ healthPublishIntervalMs: 3_600_001 }, "healthPublishIntervalMs"],
    [{ healthPublishIntervalMs: 1.5 }, "healthPublishIntervalMs"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveLarkWsConfig(config)).toThrow(field);
  });
});
