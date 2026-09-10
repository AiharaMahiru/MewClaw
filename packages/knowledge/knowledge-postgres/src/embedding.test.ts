/**
 * SiliconFlow 嵌入客户端测试（wire 边界）：响应形状校验、批次顺序、
 * 可重试状态、密钥脱敏（错误信息不出现密钥）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiliconFlowEmbeddingClient } from "./embedding.js";

const API_KEY = "sk-test-secret-value-123";
const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const ERROR_DETAIL_CHARS = 512;

function vectorOf(seed: number, size = 1024): number[] {
  return Array.from({ length: size }, (_, index) => seed + index);
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function embeddingBatch(count: number): unknown {
  return { data: Array.from({ length: count }, (_, index) => ({ index, embedding: vectorOf(index) })) };
}

describe("SiliconFlowEmbeddingClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("embedTexts：批量请求（≤8/批）并按 index 还原顺序", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.siliconflow.cn/v1/embeddings");
      const body = JSON.parse(String(init?.body)) as { input: Array<{ text: string }>; dimensions: number };
      expect(body.input.length).toBe(fetchMock.mock.calls.length === 1 ? 8 : 2);
      expect(body.dimensions).toBe(1024);
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${API_KEY}`);
      return jsonResponse(embeddingBatch(body.input.length));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    const vectors = await client.embedTexts(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(vectors).toHaveLength(10);
    expect(vectors[0]).toEqual(vectorOf(0));
    expect(fetchMock).toHaveBeenCalledTimes(2); // 8 + 2
  });

  it("批次不完整（缺失 index）抛错", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ index: 1, embedding: vectorOf(1) }] })));
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(client.embedTexts(["a", "b"])).rejects.toThrow(/incomplete/);
  });

  it("嵌入响应拒绝重复的上游索引", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      data: [
        { index: 0, embedding: vectorOf(0, 1) },
        { index: 0, embedding: vectorOf(1, 1) },
        { index: 1, embedding: vectorOf(2, 1) },
      ],
    })));
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0, dimensions: 1 });
    await expect(client.embedTexts(["a", "b"])).rejects.toThrow(/duplicate embedding index/);
  });

  it("嵌入响应的声明和实际字节超过 1 MiB 时拒绝", async () => {
    let declaredCancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      },
      cancel() {
        declaredCancelled = true;
      },
    }), {
      headers: { "content-length": String(RESPONSE_LIMIT_BYTES + 1) },
    })));
    const declaredClient = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(declaredClient.embedTexts(["a"])).rejects.toThrow(/invalid JSON/);
    expect(declaredCancelled).toBe(true);

    const oversized = `${JSON.stringify(embeddingBatch(1))}${" ".repeat(RESPONSE_LIMIT_BYTES)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(oversized)));
    const streamedClient = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(streamedClient.embedTexts(["a"])).rejects.toThrow(/invalid JSON/);
  });

  it("嵌入向量维度必须等于请求维度", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      data: [{ index: 0, embedding: [0] }],
    })));
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(client.embedTexts(["a"])).rejects.toThrow(/dimension/);
  });

  it("429 在重试次数内退避重试后成功", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) return jsonResponse({ message: "rate limited" }, 429);
      return jsonResponse(embeddingBatch(1));
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 2 });
    const vectors = await client.embedTexts(["a"]);
    expect(vectors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非可重试状态（400）不重试；错误信息脱敏密钥", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: `bad key ${API_KEY}` }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 2 });
    await expect(client.embedTexts(["a"])).rejects.toThrow(/SiliconFlow request failed \(400\)/);
    await expect(client.embedTexts(["a"])).rejects.not.toThrow(API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 两条用例各 1 次，无重试
  });

  it("上游错误详情限制为 512 字符", async () => {
    const detail = "x".repeat(ERROR_DETAIL_CHARS + 1);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: detail }, 400)));
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(client.embedTexts(["a"])).rejects.toThrow("x".repeat(ERROR_DETAIL_CHARS));
    await expect(client.embedTexts(["a"])).rejects.not.toThrow("x".repeat(ERROR_DETAIL_CHARS + 1));
  });

  it("rerank：top_n 受上限约束并按分数降序", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { top_n: number };
      expect(body.top_n).toBe(2);
      return jsonResponse({
        results: [
          { index: 2, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.3 },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    const results = await client.rerank("q", ["a", "b", "c"], 2);
    expect(results).toEqual([
      { index: 2, score: 0.9 },
      { index: 0, score: 0.3 },
    ]);
  });

  it("rerank 拒绝超出文档范围的上游索引", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      results: [{ index: 1, relevance_score: 0.9 }],
    })));
    const client = new SiliconFlowEmbeddingClient({ apiKey: API_KEY, retryCount: 0 });
    await expect(client.rerank("q", ["a"], 1)).rejects.toThrow(/index/);
  });

  it("空密钥/非法维度构造失败", () => {
    expect(() => new SiliconFlowEmbeddingClient({ apiKey: "  " })).toThrow(/API key is required/);
    expect(() => new SiliconFlowEmbeddingClient({ apiKey: "k", dimensions: 10_000 })).toThrow(/dimensions/);
  });
});
