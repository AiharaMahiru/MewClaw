import { describe, expect, it } from "vitest";

import { resolveCdgBridgeConfig } from "./config.js";

describe("cdg-bridge 配置边界", () => {
  it("缺省 command 明确关闭桥接，并使用有限超时", () => {
    expect(resolveCdgBridgeConfig({})).toEqual({ command: undefined, timeoutMs: 30_000 });
  });

  it.each([
    [{ command: "   " }, "command"],
    [{ timeoutMs: 0 }, "timeoutMs"],
    [{ timeoutMs: 999 }, "timeoutMs"],
    [{ timeoutMs: 300_001 }, "timeoutMs"],
    [{ timeoutMs: 1.5 }, "timeoutMs"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveCdgBridgeConfig(config)).toThrow(field);
  });
});
