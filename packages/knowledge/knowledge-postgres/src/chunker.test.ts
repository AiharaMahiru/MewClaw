/**
 * 分块测试：窗口/重叠/参数校验/换行归一。
 */
import { describe, expect, it } from "vitest";

import { chunkDocument, contentDigest } from "./chunker.js";

describe("chunkDocument", () => {
  it("按窗口切块且带重叠", () => {
    const chunks = chunkDocument("abcdefghij", { maxCharacters: 4, overlapCharacters: 2 });
    // 步长 2：尾段不足窗口也保留（内容不丢失）。
    expect(chunks.map((chunk) => chunk.text)).toEqual(["abcd", "cdef", "efgh", "ghij", "ij"]);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it("换行归一 + 首尾空白去除；空文本返回空数组", () => {
    expect(chunkDocument("a\r\nb\r\n", { maxCharacters: 4, overlapCharacters: 0 })).toHaveLength(1);
    expect(chunkDocument("   \n  ", { maxCharacters: 4, overlapCharacters: 0 })).toHaveLength(0);
  });

  it("参数校验 fail loud", () => {
    expect(() => chunkDocument("x", { maxCharacters: 0, overlapCharacters: 0 })).toThrow(/positive/);
    expect(() => chunkDocument("x", { maxCharacters: 4, overlapCharacters: -1 })).toThrow(/non-negative/);
    expect(() => chunkDocument("x", { maxCharacters: 4, overlapCharacters: 4 })).toThrow(/smaller/);
  });

  it("contentDigest 稳定且可区分", () => {
    expect(contentDigest("a")).toMatch(/^[a-f0-9]{64}$/);
    expect(contentDigest("a")).toBe(contentDigest("a"));
    expect(contentDigest("a")).not.toBe(contentDigest("b"));
  });
});
