/**
 * 摄入管线编排（SPEC knowledge.md §6）：任务创建 → 读源 → 分块 → 嵌入 →
 * 单事务激活 → 进度落审计。失败任一步：前一激活版本原样保留，任务置 failed。
 *
 * 源路径归属：sourcePath 必须位于 uploadsRoot/<scopeKey>/ 内（realpath
 * 校验，防逃逸）；MIME 白名单（文本类）fail loud，富格式留待 uploads SPEC。
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import type { Scope } from "dsh-lark-contracts";
import { scopeKey } from "dsh-lark-contracts";
import type {
  DocumentId,
  IngestInput,
  IngestionRun,
  Knowledge,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeSnapshot,
  KnowledgeVisibility,
  RetrieveOptions,
} from "dsh-knowledge";

import type { PostgresKnowledgeAdminService } from "./admin.js";
import { chunkDocument, type ChunkOptions } from "./chunker.js";
import { resolveKnowledgePipelineOptions, resolveRetrievalOptions } from "./config.js";
import type { KnowledgeDatabase } from "./database.js";
import type { EmbeddingClient } from "./embedding.js";
import { SILICONFLOW_EMBEDDING_MODEL } from "./embedding.js";
import type { PostgresKnowledgeIngestionService } from "./ingestion.js";
import type { PostgresKnowledgeStore } from "./store.js";

/** 文本类 MIME 白名单（M3 切片；富格式 pdf/docx/xlsx 经 uploads SPEC M4 接入）。 */
const TEXT_MIME_WHITELIST = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/x-commonmark",
  "text/html",
  "text/css",
  "text/csv",
  "text/tab-separated-values",
  "text/javascript",
  "application/json",
  "application/xml",
]);

const CATEGORIES: readonly KnowledgeCategory[] = [
  "general", "product_manual", "technical_spec", "project_document", "policy_process", "faq",
];

const MAX_TAGS = 8;
const CITATION_SNIPPET_CHARS = 160;

export interface KnowledgePipelineOptions {
  database: KnowledgeDatabase;
  store: PostgresKnowledgeStore;
  admin: PostgresKnowledgeAdminService;
  ingestions: PostgresKnowledgeIngestionService;
  embedding: EmbeddingClient;
  /** 嵌入模型名（索引键；与 embedding_model 列对齐）。 */
  embeddingModel?: string;
  chunkOptions?: ChunkOptions;
  topK?: number;
  candidateCount?: number;
  rerank?: boolean;
  ingestionConcurrency?: number;
  uploadsRoot: string;
  maxSourceBytes?: number;
}

/** 简单信号量（并发上限 + FIFO 等待队列）。 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => { this.release(); };
    }
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
    return () => { this.release(); };
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available += 1;
  }
}

/** 摄入错误分类（→ IngestionRun.errorCode；值不出现在用户面）。 */
function ingestionErrorCode(error: unknown): string {
  const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : "";
  if (code === "ENOENT") return "SOURCE_MISSING";
  return error instanceof IngestionSourceError ? error.errorCode : "INGESTION_FAILED";
}

class IngestionSourceError extends Error {
  constructor(readonly errorCode: string, message: string) {
    super(message);
    this.name = "IngestionSourceError";
  }
}

/** 契约校验（wire/调用边界）：category/tags 缺省 + MIME 白名单。 */
function defaultCategoryTags(input: IngestInput): { category: KnowledgeCategory; tags: string[] } {
  const category = input.category && CATEGORIES.includes(input.category) ? input.category : "general";
  const tags = (input.tags || []).slice(0, MAX_TAGS).filter((tag) => typeof tag === "string" && tag.trim());
  return { category, tags };
}

/** 白名单校验（管线内调用；违规抛 IngestionSourceError → 任务 failed）。 */
function validateIngestInput(input: IngestInput): void {
  if (!input.sourceName.trim()) throw new IngestionSourceError("INVALID_SOURCE", "source name is required");
  if (!TEXT_MIME_WHITELIST.has(input.sourceMime)) {
    throw new IngestionSourceError("UNSUPPORTED_MIME", `unsupported mime type: ${input.sourceMime}`);
  }
}

export class KnowledgePipeline implements Knowledge {
  private readonly database: KnowledgeDatabase;
  private readonly store: PostgresKnowledgeStore;
  private readonly admin: PostgresKnowledgeAdminService;
  private readonly ingestions: PostgresKnowledgeIngestionService;
  private readonly embedding: EmbeddingClient;
  private readonly embeddingModel: string;
  private readonly chunkOptions: ChunkOptions;
  private readonly topK: number;
  private readonly candidateCount: number;
  private readonly rerank: boolean;
  private readonly semaphore: Semaphore;
  private readonly uploadsRoot: string;
  private readonly maxSourceBytes: number;

  constructor(options: KnowledgePipelineOptions) {
    const resolved = resolveKnowledgePipelineOptions(options);
    this.database = options.database;
    this.store = options.store;
    this.admin = options.admin;
    this.ingestions = options.ingestions;
    this.embedding = options.embedding;
    this.embeddingModel = options.embeddingModel || SILICONFLOW_EMBEDDING_MODEL;
    this.chunkOptions = resolved.chunkOptions;
    this.topK = resolved.topK;
    this.candidateCount = resolved.candidateCount;
    this.rerank = resolved.rerank;
    this.semaphore = new Semaphore(resolved.ingestionConcurrency);
    this.uploadsRoot = resolve(options.uploadsRoot);
    this.maxSourceBytes = resolved.maxSourceBytes;
  }

  /** 装载期：把上次进程遗留的 processing 任务置 failed(SERVICE_RESTARTED)。 */
  async init(): Promise<void> {
    await this.ingestions.recoverInterrupted();
  }

  /** 源路径归属校验：realpath 后必须位于 uploadsRoot/<scopeKey>/ 内。 */
  private async validateSourcePath(scope: Scope, sourcePath: string): Promise<string> {
    let actual: string;
    try {
      actual = await realpath(resolve(sourcePath));
    } catch {
      throw new IngestionSourceError("SOURCE_MISSING", "source file does not exist");
    }
    let allowedRoot: string;
    try {
      allowedRoot = await realpath(resolve(this.uploadsRoot, scopeKey(scope)));
    } catch {
      // scope 归属目录不存在 → 任何现存文件都不属于该 scope（fail closed）。
      throw new IngestionSourceError("SOURCE_PATH_ESCAPED", "scope upload root does not exist");
    }
    const rel = relative(allowedRoot, actual);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(sep) || rel.includes(`..${sep}`)) {
      throw new IngestionSourceError("SOURCE_PATH_ESCAPED", "source path escapes the scope upload root");
    }
    return actual;
  }

  async ingest(scope: Scope, input: IngestInput, visibility: KnowledgeVisibility): Promise<IngestionRun> {
    return this.ingestInternal(scope, input, visibility, false);
  }

  /** 内部摄入入口（force 跳过同摘要去重——重索引路径）。 */
  private async ingestInternal(
    scope: Scope,
    input: IngestInput,
    visibility: KnowledgeVisibility,
    force: boolean,
  ): Promise<IngestionRun> {
    // 创建审计任务先行：MIME/路径等校验失败以任务 failed 形式呈现（异步管线内 fail）。
    const { category, tags } = defaultCategoryTags(input);
    const run = await this.ingestions.create(scope, {
      visibility,
      fileName: input.sourceName,
      mimeType: input.sourceMime,
      sourceSize: 0,
      category,
      tags,
    });
    void this.process(scope, run.runId, { ...input, category, tags }, visibility, force);
    return run;
  }

  /** 异步管线（信号量限量并发）；进度单调写审计。 */
  private async process(
    scope: Scope,
    runId: string,
    input: IngestInput & { category: KnowledgeCategory; tags: string[] },
    visibility: KnowledgeVisibility,
    force: boolean,
  ): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      // 输入校验（MIME 白名单/名称）在管线内完成：失败落任务审计而非调用方异常。
      validateIngestInput(input);
      await this.ingestions.advance(scope, runId, { stage: "inspecting", progress: 20 });
      const actualPath = await this.validateSourcePath(scope, input.sourcePath);
      const content = await readFile(actualPath);
      if (content.byteLength > this.maxSourceBytes) {
        throw new IngestionSourceError("SOURCE_TOO_LARGE", "source exceeds the size limit");
      }
      const sha256 = createHash("sha256").update(content).digest("hex");
      await this.ingestions.advance(scope, runId, { stage: "extracting", progress: 35 });
      const text = content.toString("utf8");
      const chunks = chunkDocument(text, this.chunkOptions);
      await this.ingestions.advance(scope, runId, { stage: "chunking", progress: 55 });
      if (chunks.length === 0) throw new IngestionSourceError("EMPTY_SOURCE", "source contains no text");
      const embeddings = await this.embedding.embedTexts(chunks.map((chunk) => chunk.text))
        .catch((error: unknown) => {
          throw new IngestionSourceError(
            "EMBEDDING_FAILED",
            `embedding failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        });
      if (embeddings.length !== chunks.length) throw new IngestionSourceError("INGESTION_FAILED", "embedding count mismatch");
      await this.ingestions.advance(scope, runId, { stage: "embedding", progress: 70 });
      const documentId = await this.store.activate({
        scope,
        visibility,
        documentKey: input.documentKey?.trim() || input.sourceName,
        source: {
          storageKey: relative(this.uploadsRoot, actualPath),
          name: input.sourceName,
          mime: input.sourceMime,
          sha256,
          size: content.byteLength,
        },
        embeddingModel: this.embeddingModel,
        chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index]! })),
        metadata: { sourceChannel: "admin", category: input.category, tags: input.tags },
        ...(force ? { force: true } : {}),
      });
      await this.ingestions.advance(scope, runId, { stage: "indexing", progress: 90 });
      await this.ingestions.complete(scope, runId, documentId);
    } catch (error) {
      await this.ingestions.fail(scope, runId, ingestionErrorCode(error)).catch(() => undefined);
    } finally {
      release();
    }
  }

  async retrieve(scope: Scope, query: string, opts?: RetrieveOptions): Promise<KnowledgeHit[]> {
    if (!query.trim()) return [];
    const { topK, candidateCount } = resolveRetrievalOptions(opts ?? {}, {
      topK: this.topK,
      candidateCount: this.candidateCount,
    });
    const [queryEmbedding] = await this.embedding.embedTexts([query]);
    const candidates = await this.store.search({
      scope,
      queryText: query,
      queryEmbedding: queryEmbedding!,
      embeddingModel: this.embeddingModel,
      limit: Math.max(candidateCount, topK),
    });
    if (candidates.length === 0) return [];
    let ranked = candidates;
    if (this.rerank && opts?.rerank !== false) {
      const reranked = await this.embedding.rerank(
        query,
        candidates.map((candidate) => candidate.text),
        Math.min(topK, candidates.length),
      );
      ranked = reranked.map((result) => candidates[result.index]!).filter((candidate) => candidate !== undefined);
    }
    return ranked.slice(0, topK).map((candidate) => ({
      docId: candidate.documentId as DocumentId,
      documentKey: candidate.documentKey,
      name: candidate.name,
      version: candidate.version,
      visibility: candidate.visibility,
      chunk: candidate.ordinal,
      text: candidate.text,
      score: candidate.fusedScore,
      citation: {
        source: candidate.documentId,
        snippet: candidate.text.slice(0, CITATION_SNIPPET_CHARS),
        score: candidate.fusedScore,
      },
    }));
  }

  snapshot(scope: Scope): Promise<KnowledgeSnapshot> {
    return this.admin.snapshot(scope);
  }

  getDocument(scope: Scope, docId: DocumentId) {
    return this.admin.get(scope, docId);
  }

  archive(scope: Scope, docId: DocumentId) {
    return this.admin.archive(scope, docId);
  }

  restore(scope: Scope, docId: DocumentId) {
    return this.admin.restore(scope, docId);
  }

  moveVisibility(scope: Scope, docId: DocumentId, target: KnowledgeVisibility) {
    return this.admin.moveVisibility(scope, docId, target);
  }

  /** 重索引：从原始源重建（force 跳过同摘要去重；等待新任务落定后返回新文档）。 */
  async reindex(scope: Scope, docId: DocumentId, opts: { force: boolean }): Promise<KnowledgeDocument | undefined> {
    const source = await this.admin.reindexSource(scope, docId);
    if (!source) return undefined;
    const input: IngestInput = {
      sourcePath: resolve(this.uploadsRoot, source.sourcePath),
      sourceName: source.name,
      sourceMime: source.mime,
      documentKey: source.documentKey,
      category: source.category,
      tags: source.tags,
    };
    const run = await this.ingestInternal(scope, input, source.visibility, opts.force);
    const settled = await this.waitForRun(scope, run.runId);
    if (!settled?.documentId) return undefined;
    return this.admin.get(scope, settled.documentId);
  }

  /** 轮询任务至终态（管理面动作，有界等待）。 */
  private async waitForRun(scope: Scope, runId: string): Promise<IngestionRun | undefined> {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      const run = await this.ingestions.get(scope, runId);
      if (!run || run.status === "processing") {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      return run;
    }
    return undefined;
  }

  ingestionRuns(scope: Scope, limit?: number): Promise<IngestionRun[]> {
    return this.ingestions.list(scope, limit);
  }

  ingestionRun(scope: Scope, runId: string): Promise<IngestionRun | undefined> {
    return this.ingestions.get(scope, runId);
  }
}
