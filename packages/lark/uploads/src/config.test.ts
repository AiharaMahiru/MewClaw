import { describe, expect, it } from "vitest";

import { resolveUploadsConfig } from "./config.js";

describe("lark-uploads 配置边界", () => {
  it("使用每类输入的有限默认预算", () => {
    expect(resolveUploadsConfig({})).toEqual({
      maxAttachmentBytes: 100 * 1024 * 1024,
      maxTextFileBytes: 10 * 1024 * 1024,
      maxImageInputBytes: 50 * 1024 * 1024,
      ingestWaitMs: 60_000,
    });
  });

  it("保留合法的最小显式预算", () => {
    expect(resolveUploadsConfig({
      maxAttachmentBytes: 1,
      maxTextFileBytes: 1,
      maxImageInputBytes: 1,
      ingestWaitMs: 1_000,
    })).toEqual({ maxAttachmentBytes: 1, maxTextFileBytes: 1, maxImageInputBytes: 1, ingestWaitMs: 1_000 });
  });

  it.each([
    [{ maxAttachmentBytes: 0 }, "maxAttachmentBytes"],
    [{ maxTextFileBytes: 0 }, "maxTextFileBytes"],
    [{ maxImageInputBytes: 0 }, "maxImageInputBytes"],
    [{ ingestWaitMs: 0 }, "ingestWaitMs"],
    [{ ingestWaitMs: 300_001 }, "ingestWaitMs"],
    [{ maxTextFileBytes: 1.5 }, "maxTextFileBytes"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveUploadsConfig(config)).toThrow(field);
  });
});
