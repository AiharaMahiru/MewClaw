/**
 * 文本分块（lark-claw chunker 平移）：滑动窗口，重叠区避免语义截断。
 * 步长 = maxCharacters - overlapCharacters；chunk id 由内容派生（确定性）。
 */
import { createHash } from "node:crypto";

export interface ChunkOptions {
  maxCharacters: number;
  overlapCharacters: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxCharacters: 4_000,
  overlapCharacters: 400,
};

export interface KnowledgeChunk {
  ordinal: number;
  text: string;
}

function validateOptions(options: ChunkOptions): void {
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1) {
    throw new Error("maxCharacters must be a positive integer");
  }
  if (!Number.isInteger(options.overlapCharacters) || options.overlapCharacters < 0) {
    throw new Error("overlapCharacters must be a non-negative integer");
  }
  if (options.overlapCharacters >= options.maxCharacters) {
    throw new Error("overlapCharacters must be smaller than maxCharacters");
  }
}

/** 按字符窗口切块；统一换行并去除首尾空白（空文本返回空数组）。 */
export function chunkDocument(text: string, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): KnowledgeChunk[] {
  validateOptions(options);
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const chunks: KnowledgeChunk[] = [];
  const step = options.maxCharacters - options.overlapCharacters;
  for (let start = 0, ordinal = 0; start < normalized.length; start += step, ordinal += 1) {
    chunks.push({ ordinal, text: normalized.slice(start, start + options.maxCharacters) });
  }
  return chunks;
}

/** 块内容摘要（同摘要去重比对用）。 */
export function contentDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
