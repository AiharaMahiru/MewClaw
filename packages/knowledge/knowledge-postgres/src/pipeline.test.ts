/**
 * KnowledgePipeline 测试（SPEC knowledge.md §8 e2e 面）：
 * PGlite 真库 + mock 嵌入客户端（无密钥可重放），验证完整链路：
 * 摄入 → 检索 → 引用字段；失败路径（MIME/路径逃逸/缺失/嵌入失败）
 * 与任务审计状态；重索引 force 语义。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, scopeKey, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { PostgresKnowledgeAdminService } from "./admin.js";
import type { KnowledgeDatabase } from "./database.js";
import type { EmbeddingClient } from "./embedding.js";
import { PostgresKnowledgeIngestionService } from "./ingestion.js";
import { KNOWLEDGE_MIGRATIONS } from "./migrations.js";
import { KnowledgePipeline, type KnowledgePipelineOptions } from "./pipeline.js";
import { PostgresKnowledgeStore } from "./store.js";

const databases: PGlite[] = [];
const tempDirs: string[] = [];
let uploadsRoot: string;

beforeEach(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), "dsh-lark-knowledge-"));
  tempDirs.push(uploadsRoot);
});

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function knowledgeDatabase(pg: PGlite): KnowledgeDatabase {
  return {
    query: (sql, params) => pg.query(sql, params),
    execute: async (sql) => { await pg.exec(sql); },
    transaction: (run) => pg.transaction(async (tx) => run({
      query: (sql, params) => tx.query(sql, params),
      execute: async (sql) => { await tx.exec(sql); },
    })),
  };
}

function embeddingOf(seed: number): number[] {
  let value = seed;
  const result: number[] = [];
  for (let i = 0; i < 1024; i += 1) {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    result.push((value / 4_294_967_296) * 2 - 1);
  }
  return result;
}

/** mock 嵌入客户端：文本哈希 → 确定性向量；重排 = 原序倒置。 */
function mockEmbedding(): EmbeddingClient {
  return {
    embedTexts: async (texts) => texts.map((text) => embeddingOf(text.length)),
    rerank: async (_query, documents, topK) => documents
      .map((_, index) => ({ index, score: 1 - index / Math.max(documents.length, 1) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK),
  };
}

function scope(userId: string): Scope {
  return {
    tenantId: makeTenantId("t"),
    botId: makeBotId("b"),
    deploymentId: makeDeploymentId("d"),
    userId: makeUserId(userId),
    conversationId: makeConversationId("oc_1"),
  };
}

function pipelineOptions(overrides: Partial<KnowledgePipelineOptions> = {}): KnowledgePipelineOptions {
  return {
    database: {} as never,
    store: {} as never,
    admin: {} as never,
    ingestions: {} as never,
    embedding: {} as never,
    uploadsRoot,
    ...overrides,
  };
}

async function makePipeline(): Promise<{ pipeline: KnowledgePipeline; pg: PGlite }> {
  const pg = await PGlite.create({ extensions: { vector } });
  databases.push(pg);
  const database = knowledgeDatabase(pg);
  await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
  const instance = new KnowledgePipeline({
    database,
    store: new PostgresKnowledgeStore(database),
    admin: new PostgresKnowledgeAdminService(database),
    ingestions: new PostgresKnowledgeIngestionService(database),
    embedding: mockEmbedding(),
    embeddingModel: "test/model",
    uploadsRoot,
    chunkOptions: { maxCharacters: 400, overlapCharacters: 40 },
    topK: 3,
    candidateCount: 10,
    rerank: true,
  });
  await instance.init();
  return { pipeline: instance, pg };
}

/** 在 scope 归属目录写源文件（模拟 admin 上传落盘）。 */
async function writeSource(user: Scope, name: string, content: string): Promise<string> {
  const dir = join(uploadsRoot, scopeKey(user));
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

/** 轮询任务直到终态（处理中 → 完成/失败）。 */
async function waitForRun(
  instance: KnowledgePipeline,
  user: Scope,
  runId: string,
): Promise<NonNullable<Awaited<ReturnType<KnowledgePipeline["ingestionRun"]>>>> {
  // PGlite 在全量并行门禁下可能需要数秒完成事务调度；仍保持有界等待。
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const run = await instance.ingestionRun(user, runId);
    if (!run || run.status === "processing") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    return run;
  }
  throw new Error("ingestion run did not settle");
}

describe("KnowledgePipeline", () => {
  it("直接构造也拒绝越界运行时配置", () => {
    expect(() => new KnowledgePipeline(pipelineOptions({
      chunkOptions: { maxCharacters: 4, overlapCharacters: 4 },
    }))).toThrow("overlapCharacters");
    expect(() => new KnowledgePipeline(pipelineOptions({ topK: 0 }))).toThrow("topK");
    expect(() => new KnowledgePipeline(pipelineOptions({ candidateCount: 101 }))).toThrow("candidateCount");
    expect(() => new KnowledgePipeline(pipelineOptions({ ingestionConcurrency: 0 }))).toThrow("ingestionConcurrency");
    expect(() => new KnowledgePipeline(pipelineOptions({ maxSourceBytes: 0 }))).toThrow("maxSourceBytes");
  });

  it("e2e：文本摄入 → 检索命中（引用字段齐备）→ 跨用户私有拒绝", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const bob = scope("ou_b");
    const sourcePath = await writeSource(alice, "notes.md", "# 手册\n\n这是关于 MewClaw 的知识库文档内容。".repeat(30));

    const run = await pipeline.ingest(alice, {
      sourcePath,
      sourceName: "notes.md",
      sourceMime: "text/markdown",
      category: "product_manual",
      tags: ["manual"],
    }, "user_private");
    const settled = await waitForRun(pipeline, alice, run.runId);
    expect(settled.status).toBe("completed");
    expect(settled.documentId).toBeTruthy();

    const hits = await pipeline.retrieve(alice, "知识库文档内容");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      documentKey: "notes.md",
      name: "notes.md",
      version: 1,
      visibility: "user_private",
    });
    expect(hits[0]!.citation).toMatchObject({ source: hits[0]!.docId });
    expect(hits[0]!.citation.snippet.length).toBeGreaterThan(0);

    expect(await pipeline.retrieve(bob, "知识库文档内容")).toHaveLength(0);
  });

  it("MIME 非文本白名单 → 任务 failed(UNSUPPORTED_MIME)", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const sourcePath = await writeSource(alice, "file.pdf", "not really pdf");

    const run = await pipeline.ingest(alice, {
      sourcePath,
      sourceName: "file.pdf",
      sourceMime: "application/pdf",
    }, "user_private");
    const settled = await waitForRun(pipeline, alice, run.runId);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("UNSUPPORTED_MIME");
  });

  it("路径逃逸（uploadsRoot 外）→ failed(SOURCE_PATH_ESCAPED)", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const outside = join(tmpdir(), "escape-source.md");
    tempDirs.push(outside);
    await writeFile(outside, "# 逃逸内容", "utf8");

    const run = await pipeline.ingest(alice, {
      sourcePath: outside,
      sourceName: "escape.md",
      sourceMime: "text/markdown",
    }, "user_private");
    const settled = await waitForRun(pipeline, alice, run.runId);
    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("SOURCE_PATH_ESCAPED");
  });

  it("源缺失 → failed(SOURCE_MISSING)；嵌入失败 → failed(EMBEDDING_FAILED)", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const dir = join(uploadsRoot, scopeKey(alice));
    await mkdir(dir, { recursive: true });

    const missingRun = await pipeline.ingest(alice, {
      sourcePath: join(dir, "ghost.md"),
      sourceName: "ghost.md",
      sourceMime: "text/markdown",
    }, "user_private");
    expect((await waitForRun(pipeline, alice, missingRun.runId)).errorCode).toBe("SOURCE_MISSING");

    // 嵌入失败：换一个抛错的嵌入客户端重新装配管线（同库不同实例）。
    const sourcePath = await writeSource(alice, "ok.md", "# 正常内容");
    const pg = databases[0]!;
    const database = knowledgeDatabase(pg);
    const broken = new KnowledgePipeline({
      database,
      store: new PostgresKnowledgeStore(database),
      admin: new PostgresKnowledgeAdminService(database),
      ingestions: new PostgresKnowledgeIngestionService(database),
      embedding: { embedTexts: async () => { throw new Error("upstream down"); }, rerank: mockEmbedding().rerank },
      embeddingModel: "test/model",
      uploadsRoot,
    });
    const run = await broken.ingest(alice, {
      sourcePath,
      sourceName: "ok.md",
      sourceMime: "text/markdown",
    }, "user_private");
    expect((await waitForRun(broken, alice, run.runId)).errorCode).toBe("EMBEDDING_FAILED");
  });

  it("同摘要重复摄入幂等；reindex(force) 产生新版本", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const sourcePath = await writeSource(alice, "notes.md", "# 固定内容版本一");

    const first = await waitForRun(pipeline, alice, (await pipeline.ingest(alice, {
      sourcePath,
      sourceName: "notes.md",
      sourceMime: "text/markdown",
    }, "user_private")).runId);
    const second = await waitForRun(pipeline, alice, (await pipeline.ingest(alice, {
      sourcePath,
      sourceName: "notes.md",
      sourceMime: "text/markdown",
    }, "user_private")).runId);
    expect(second.documentId).toBe(first.documentId);

    const reindexed = await pipeline.reindex(alice, first.documentId!, { force: true });
    expect(reindexed?.version).toBe(2);
    expect(reindexed?.status).toBe("active");
  });

  it("归档后检索不可见；恢复后重新可见（服务面串联）", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    const sourcePath = await writeSource(alice, "notes.md", "# 归档演练内容");
    const run = await waitForRun(pipeline, alice, (await pipeline.ingest(alice, {
      sourcePath,
      sourceName: "notes.md",
      sourceMime: "text/markdown",
    }, "user_private")).runId);
    const docId = run.documentId!;

    expect(await pipeline.retrieve(alice, "归档演练")).toHaveLength(1);
    expect((await pipeline.archive(alice, docId))?.status).toBe("deleted");
    expect(await pipeline.retrieve(alice, "归档演练")).toHaveLength(0);
    expect((await pipeline.restore(alice, docId))?.status).toBe("active");
    expect(await pipeline.retrieve(alice, "归档演练")).toHaveLength(1);
  });

  it("空查询返回空列表（非错误）；无结果非错误", async () => {
    const { pipeline } = await makePipeline();
    const alice = scope("ou_a");
    expect(await pipeline.retrieve(alice, "   ")).toEqual([]);
    expect(await pipeline.retrieve(alice, "没有任何内容会命中")).toEqual([]);
  });
});
