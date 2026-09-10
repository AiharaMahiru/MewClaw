import { describe, expect, it } from "vitest";

import { resolveKnowledgePipelineOptions } from "./config.js";

describe("knowledge-postgres 运行时配置边界", () => {
  it("只在字段缺省时使用文档默认值", () => {
    expect(resolveKnowledgePipelineOptions({})).toEqual({
      chunkOptions: { maxCharacters: 4_000, overlapCharacters: 400 },
      topK: 5,
      candidateCount: 20,
      rerank: true,
      ingestionConcurrency: 2,
      maxSourceBytes: 100 * 1024 * 1024,
    });
  });

  it("接受框架生成的空分块对象并使用字段默认值", () => {
    expect(resolveKnowledgePipelineOptions({ chunkOptions: {} })).toMatchObject({
      chunkOptions: { maxCharacters: 4_000, overlapCharacters: 400 },
    });
  });

  it("保留零重叠与声明范围内的显式值", () => {
    expect(resolveKnowledgePipelineOptions({
      chunkOptions: { maxCharacters: 10_000, overlapCharacters: 0 },
      topK: 20,
      candidateCount: 100,
      rerank: false,
      ingestionConcurrency: 8,
      maxSourceBytes: 100 * 1024 * 1024,
    })).toEqual({
      chunkOptions: { maxCharacters: 10_000, overlapCharacters: 0 },
      topK: 20,
      candidateCount: 100,
      rerank: false,
      ingestionConcurrency: 8,
      maxSourceBytes: 100 * 1024 * 1024,
    });
  });

  it.each([
    [{ chunkOptions: { maxCharacters: 0, overlapCharacters: 0 } }, "maxCharacters"],
    [{ chunkOptions: { maxCharacters: 4, overlapCharacters: 4 } }, "overlapCharacters"],
    [{ topK: 0 }, "topK"],
    [{ candidateCount: 0 }, "candidateCount"],
    [{ ingestionConcurrency: 0 }, "ingestionConcurrency"],
    [{ ingestionConcurrency: 9 }, "ingestionConcurrency"],
    [{ maxSourceBytes: 0 }, "maxSourceBytes"],
    [{ maxSourceBytes: 100 * 1024 * 1024 + 1 }, "maxSourceBytes"],
  ])("拒绝非法 %o", (config, field) => {
    expect(() => resolveKnowledgePipelineOptions(config)).toThrow(field);
  });
});
