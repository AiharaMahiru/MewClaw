/**
 * M3b e2e（SPEC uploads.md §8）：dsh-lark-uploads.prepare 与真实
 * knowledge-postgres 管线串联（PGlite+pgvector 真库 + mock 嵌入，键无关）：
 * 网关落盘形态的附件 → 物化 → 提取 → 摄入落库 → 检索可见。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, scopeKey, type RunAttachment, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "../infra/postgres/src/migration.js";

import { PostgresKnowledgeAdminService } from "../packages/knowledge/knowledge-postgres/src/admin.js";
import type { KnowledgeDatabase } from "../packages/knowledge/knowledge-postgres/src/database.js";
import type { EmbeddingClient } from "../packages/knowledge/knowledge-postgres/src/embedding.js";
import { PostgresKnowledgeIngestionService } from "../packages/knowledge/knowledge-postgres/src/ingestion.js";
import { KNOWLEDGE_MIGRATIONS } from "../packages/knowledge/knowledge-postgres/src/migrations.js";
import { KnowledgePipeline } from "../packages/knowledge/knowledge-postgres/src/pipeline.js";
import { PostgresKnowledgeStore } from "../packages/knowledge/knowledge-postgres/src/store.js";
import { apply as applyUploads, type LarkUploads } from "../packages/lark/uploads/src/index.js";

const databases: PGlite[] = [];
const tempDirs: string[] = [];
let uploadsRoot: string;
let workspace: string;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "dsh-lark-uploads-e2e-"));
  tempDirs.push(base);
  uploadsRoot = join(base, ".uploads");
  workspace = join(base, "workspace");
  await mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});
afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function databaseOf(pg: PGlite): KnowledgeDatabase {
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

const mockEmbedding: EmbeddingClient = {
  embedTexts: async (texts) => texts.map((text) => embeddingOf(text.length)),
  rerank: async (_query, documents, topK) => documents
    .map((_, index) => ({ index, score: 1 - index / Math.max(documents.length, 1) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, topK),
};

const scope: Scope = {
  tenantId: makeTenantId("t"),
  botId: makeBotId("b"),
  deploymentId: makeDeploymentId("d"),
  userId: makeUserId("ou_1"),
  conversationId: makeConversationId("oc_1"),
};

describe("uploads prepare → knowledge 链路 e2e", () => {
  it("摄入意图：物化 + 提取 + 真库摄入 → 检索可见", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = databaseOf(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const pipeline = new KnowledgePipeline({
      database,
      store: new PostgresKnowledgeStore(database),
      admin: new PostgresKnowledgeAdminService(database),
      ingestions: new PostgresKnowledgeIngestionService(database),
      embedding: mockEmbedding,
      embeddingModel: "test/model",
      uploadsRoot,
      chunkOptions: { maxCharacters: 200, overlapCharacters: 20 },
    });
    await pipeline.init();

    let uploadsService: LarkUploads | undefined;
    const ctx = {
      knowledge: pipeline,
      provide: (_name: string, value: LarkUploads) => { uploadsService = value; },
    };
    applyUploads(ctx as never, { uploadsRoot });

    // 网关落盘形态：storageKey/<uuid>-<sha>.md
    const content = "# M3b 附件摄入验收\n\n这是附件管线端到端验收内容。";
    const sha = createHash("sha256").update(content).digest("hex");
    const attachment: RunAttachment = {
      id: "44444444-4444-4444-8444-444444444444",
      fileName: "m3b.md",
      mimeType: "text/markdown",
      sha256: sha,
      size: Buffer.byteLength(content),
      encryption: "none",
      storageKey: `${scopeKey(scope)}/44444444-4444-4444-8444-444444444444-${sha}.md`,
    };
    const dir = join(uploadsRoot, scopeKey(scope));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${attachment.id}-${sha}.md`), content, "utf8");

    const { blocks } = await uploadsService!.prepare({
      scope,
      session: { append: () => undefined } as never,
      workspace,
      message: "请把这个文件添加到知识库",
      attachments: [attachment],
    });

    expect(blocks.join("\n")).toContain("stored=1");
    expect(blocks.join("\n")).toContain("<authorized_attachments>");

    // 检索可见（无意图时同管线检索该文档内容）。
    const hits = await pipeline.retrieve(scope, "附件管线端到端验收");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.documentKey).toBe(sha);
    expect(hits[0]!.visibility).toBe("user_private");
  });
});
