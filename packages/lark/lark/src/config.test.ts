import { describe, expect, it } from "vitest";

import { resolveLarkConfig } from "./config.js";

describe("dsh-lark 配置边界", () => {
  it("缺省时使用有限资源下载上限", () => {
    expect(resolveLarkConfig({})).toEqual({ maxResourceBytes: 50 * 1024 * 1024 });
  });

  it.each([0, -1, 100 * 1024 * 1024 + 1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "拒绝非法 maxResourceBytes=%s",
    (maxResourceBytes) => {
      expect(() => resolveLarkConfig({ maxResourceBytes })).toThrow("maxResourceBytes");
    },
  );
});
