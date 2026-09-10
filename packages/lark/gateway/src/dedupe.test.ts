import { describe, expect, it } from "vitest";

import { Dedupe } from "./dedupe.js";

describe("Dedupe 构造边界", () => {
  it("拒绝无效的 TTL 和容量", () => {
    expect(() => new Dedupe({ ttlMs: 0, maxEntries: 1 })).toThrow("ttlMs");
    expect(() => new Dedupe({ ttlMs: 1, maxEntries: 0 })).toThrow("maxEntries");
  });
});
