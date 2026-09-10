/**
 * SiliconFlow 嵌入/重排客户端（lark-claw siliconflow-client 平移）。
 *
 * 差异：zod wire 校验改为手写边界校验（本仓库无 zod；规则 7 允许
 * wire 边界手写校验）。重试（429/503/504，2 次退避）、批大小 8、
 * 120s 超时、密钥不出现在错误信息——语义逐条保留。
 */

export const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
export const SILICONFLOW_EMBEDDING_MODEL = "Qwen/Qwen3-VL-Embedding-8B";
export const SILICONFLOW_RERANK_MODEL = "Qwen/Qwen3-VL-Reranker-8B";
export const SILICONFLOW_EMBEDDING_DIMENSIONS = 1_024;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_COUNT = 2;
const MAX_TEXT_EMBEDDING_BATCH_SIZE = 8;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MULTIPLIER = 2;
const RETRYABLE_STATUS = new Set([429, 503, 504]);
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 512;
const MAX_TRACE_ID_CHARS = 128;

export interface EmbeddingClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  dimensions?: number;
  retryCount?: number;
  timeoutMs?: number;
}

export interface RerankResult {
  index: number;
  score: number;
}

/** 嵌入/重排客户端（只做嵌入与重排；图片嵌入 M3 不迁移）。 */
export interface EmbeddingClient {
  embedTexts(texts: string[]): Promise<number[][]>;
  rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 响应形状校验（wire 边界手写）：嵌入必须逐索引完整。 */
function parseEmbeddings(input: unknown, count: number, dimensions: number): number[][] {
  if (typeof input !== "object" || input === null) throw new Error("SiliconFlow returned a malformed embedding response");
  const data = (input as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) throw new Error("SiliconFlow returned an empty embedding batch");
  const byIndex = new Map<number, number[]>();
  for (const item of data) {
    if (typeof item !== "object" || item === null) throw new Error("SiliconFlow returned a malformed embedding entry");
    const { index, embedding } = item as { index?: unknown; embedding?: unknown };
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= count || !Array.isArray(embedding)) {
      throw new Error("SiliconFlow returned a malformed embedding entry");
    }
    if (byIndex.has(index)) throw new Error("SiliconFlow returned a duplicate embedding index");
    if (embedding.length !== dimensions) throw new Error("SiliconFlow returned an embedding with invalid dimensions");
    if (embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("SiliconFlow returned a malformed embedding entry");
    }
    byIndex.set(index, embedding as number[]);
  }
  if (byIndex.size !== count) throw new Error("SiliconFlow returned an incomplete embedding batch");
  const ordered: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    const vector = byIndex.get(i);
    if (!vector) throw new Error("SiliconFlow returned an incomplete embedding batch");
    ordered.push(vector);
  }
  return ordered;
}

/** 重排响应形状校验（wire 边界手写）。 */
function parseRerank(input: unknown, documentCount: number): RerankResult[] {
  if (typeof input !== "object" || input === null) throw new Error("SiliconFlow returned a malformed rerank response");
  const results = (input as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new Error("SiliconFlow returned a malformed rerank response");
  const seenIndexes = new Set<number>();
  return results.map((item) => {
    const { index, relevance_score: score } = item as { index?: unknown; relevance_score?: unknown };
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= documentCount || seenIndexes.has(index)) {
      throw new Error("SiliconFlow returned a rerank entry with an invalid index");
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new Error("SiliconFlow returned a malformed rerank entry");
    }
    seenIndexes.add(index);
    return { index, score };
  });
}

function invalidJsonResponse(): Error {
  return new Error("SiliconFlow returned an invalid JSON response");
}

function declaredBodySize(response: Response): number {
  const header = response.headers.get("content-length");
  if (header === null) return 0;
  if (!/^\d+$/.test(header)) throw invalidJsonResponse();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw invalidJsonResponse();
  return size;
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidJsonResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > MAX_RESPONSE_BYTES) throw invalidJsonResponse();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalidJsonResponse();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    throw invalidJsonResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await readResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJsonResponse();
  }
}

export class SiliconFlowEmbeddingClient implements EmbeddingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly dimensions: number;
  private readonly retryCount: number;
  private readonly timeoutMs: number;

  constructor(config: EmbeddingClientConfig) {
    if (!config.apiKey.trim()) throw new Error("SiliconFlow API key is required");
    this.apiKey = config.apiKey.trim();
    this.baseUrl = (config.baseUrl || SILICONFLOW_BASE_URL).replace(/\/+$/, "");
    this.fetch = config.fetch || globalThis.fetch;
    this.dimensions = config.dimensions ?? SILICONFLOW_EMBEDDING_DIMENSIONS;
    if (!Number.isInteger(this.dimensions) || this.dimensions < 1 || this.dimensions > 4_096) {
      throw new Error("SiliconFlow embedding dimensions must be between 1 and 4096");
    }
    this.retryCount = config.retryCount ?? DEFAULT_RETRY_COUNT;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) return readJsonResponse(response);
      const error = await this.responseError(response);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === this.retryCount) throw error;
      await delay(RETRY_BASE_DELAY_MS * (RETRY_MULTIPLIER ** attempt));
    }
    throw new Error("SiliconFlow request exhausted retries");
  }

  /** 上游错误脱敏：密钥与响应体细节不进入错误信息。 */
  private async responseError(response: Response): Promise<Error> {
    let detail = response.statusText.slice(0, MAX_ERROR_DETAIL_CHARS) || "unknown upstream error";
    try {
      const body = await readJsonResponse(response) as { message?: unknown };
      if (typeof body.message === "string") detail = body.message.slice(0, MAX_ERROR_DETAIL_CHARS);
    } catch { /* 保留受限的状态文本，避免异常错误体进入日志。 */ }
    const traceId = response.headers.get("x-siliconcloud-trace-id")?.slice(0, MAX_TRACE_ID_CHARS);
    const trace = traceId ? `, trace ${traceId}` : "";
    const message = `SiliconFlow request failed (${response.status}${trace}): ${detail}`;
    return new Error(message.replaceAll(this.apiKey, "[REDACTED]"));
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0 || texts.some((text) => !text.trim())) {
      throw new Error("Embedding input must contain non-empty text");
    }
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += MAX_TEXT_EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + MAX_TEXT_EMBEDDING_BATCH_SIZE);
      const response = await this.post("/embeddings", {
        model: SILICONFLOW_EMBEDDING_MODEL,
        input: batch.map((text) => ({ text })),
        encoding_format: "float",
        dimensions: this.dimensions,
      });
      vectors.push(...parseEmbeddings(response, batch.length, this.dimensions));
    }
    return vectors;
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]> {
    if (!query.trim() || documents.length === 0) throw new Error("Rerank inputs must not be empty");
    if (!Number.isInteger(topK) || topK < 1) throw new Error("topK must be a positive integer");
    const response = await this.post("/rerank", {
      model: SILICONFLOW_RERANK_MODEL,
      query,
      documents: documents.map((text) => ({ text })),
      top_n: Math.min(topK, documents.length),
      return_documents: false,
    });
    return parseRerank(response, documents.length)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(topK, documents.length));
  }
}
