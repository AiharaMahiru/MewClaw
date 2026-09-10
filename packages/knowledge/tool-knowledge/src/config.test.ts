import { describe, expect, it } from "vitest";

import { resolveToolKnowledgeConfig } from "./config.js";

describe("tool-knowledge 配置边界", () => {
  it("只在字段缺省时使用文档默认值", () => {
    expect(resolveToolKnowledgeConfig({})).toEqual({
      topK: 5,
      candidateCount: 20,
      rerank: true,
      timeoutMs: 60_000,
    });
  });

  it("保留关闭重排和声明范围内的显式值", () => {
    expect(resolveToolKnowledgeConfig({
      topK: 20,
      candidateCount: 100,
      rerank: false,
      timeoutMs: 300_000,
    })).toEqual({
      topK: 20,
      candidateCount: 100,
      rerank: false,
      timeoutMs: 300_000,
    });
  });

  it.each([
    [{ topK: 0 }, "topK"],
    [{ topK: 20.5 }, "topK"],
    [{ topK: 21 }, "topK"],
    [{ candidateCount: 0 }, "candidateCount"],
    [{ candidateCount: 101 }, "candidateCount"],
    [{ timeoutMs: 0 }, "timeoutMs"],
    [{ timeoutMs: 300_001 }, "timeoutMs"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveToolKnowledgeConfig(config)).toThrow(field);
  });
});
