/**
 * M3 验收 e2e（SPEC knowledge.md §8）：真 PostgreSQL + pgvector +
 * 真 SiliconFlow 嵌入/重排，全链路验证：
 * 摄入（真实嵌入）→ 检索（引用字段）→ 跨用户私有拒绝 → 归档后不可检索。
 *
 * 仅在 DSH_RUN_EXTERNAL_E2E=1 且调用方显式注入凭证时执行。
 * 默认门禁不读取 .env，也不调用真实 Provider。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, afterAll, describe, expect, it } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  scopeKey,
  type Scope,
} from "dsh-lark-contracts";
import { runMigrations } from "../infra/postgres/src/migration.js";

import { PostgresKnowledgeAdminService } from "../packages/knowledge/knowledge-postgres/src/admin.js";
import { PgKnowledgeDatabase } from "../packages/knowledge/knowledge-postgres/src/database.js";
import { SiliconFlowEmbeddingClient } from "../packages/knowledge/knowledge-postgres/src/embedding.js";
import { PostgresKnowledgeIngestionService } from "../packages/knowledge/knowledge-postgres/src/ingestion.js";
import { KNOWLEDGE_MIGRATIONS } from "../packages/knowledge/knowledge-postgres/src/migrations.js";
import { KnowledgePipeline } from "../packages/knowledge/knowledge-postgres/src/pipeline.js";
import { PostgresKnowledgeStore } from "../packages/knowledge/knowledge-postgres/src/store.js";

const externalE2eEnabled = process.env.DSH_RUN_EXTERNAL_E2E === "1";

function externalE2eConfig(): { apiKey: string; databaseUrl: string } {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const databaseUrl = process.env.DATABASE_URL;
  if (!apiKey || !databaseUrl) {
    throw new Error("External knowledge E2E requires injected SILICONFLOW_API_KEY and DATABASE_URL.");
  }
  return { apiKey, databaseUrl };
}

const runMark = Date.now().toString(36);
const tenant = `e2e-${runMark}`;
let uploadsRoot: string;

function scopeOf(userId: string): Scope {
  return {
    tenantId: makeTenantId(tenant),
    botId: makeBotId("default"),
    deploymentId: makeDeploymentId("default"),
    userId: makeUserId(userId),
    conversationId: makeConversationId("oc-e2e"),
  };
}

let pipeline: KnowledgePipeline | undefined;
let database: PgKnowledgeDatabase | undefined;

beforeAll(async () => {
  uploadsRoot = await mkdtemp(join(tmpdir(), "dsh-lark-knowledge-e2e-"));
});

afterAll(async () => {
  await database?.close();
  await rm(uploadsRoot!, { recursive: true, force: true });
});

describe.skipIf(!externalE2eEnabled)("知识 e2e（真 PG + 真嵌入）", () => {
  it("摄入 → 检索（引用）→ 跨用户拒绝 → 归档不可检索", async () => {
    const { apiKey, databaseUrl } = externalE2eConfig();
    const db = new PgKnowledgeDatabase(databaseUrl);
    database = db;
    await runMigrations(db, [...KNOWLEDGE_MIGRATIONS]);
    pipeline = new KnowledgePipeline({
      database: db,
      store: new PostgresKnowledgeStore(db),
      admin: new PostgresKnowledgeAdminService(db),
      ingestions: new PostgresKnowledgeIngestionService(db),
      embedding: new SiliconFlowEmbeddingClient({ apiKey }),
      uploadsRoot,
    });
    const instance = pipeline;
    await instance.init();

    const alice = scopeOf("ou-e2e-a");
    const bob = scopeOf("ou-e2e-b");
    const dir = join(uploadsRoot, scopeKey(alice));
    await mkdir(dir, { recursive: true });
    const sourcePath = join(dir, "m3-e2e.md");
    await writeFile(sourcePath, [
      "# M3 验收文档",
      "",
      "MewClaw 的知识库支持私有与共享两种可见性。",
      "私有文档仅创建者可见；共享文档对同部署全部用户开放。",
      "检索结果必须附带来源引用，归档后立即不可检索。",
    ].join("\n"), "utf8");

    // 摄入（真实嵌入调用）。
    const ingestOnce = async () => {
      const attemptRun = await instance.ingest(alice, {
        sourcePath,
        sourceName: "m3-e2e.md",
        sourceMime: "text/markdown",
        category: "technical_spec",
      }, "user_private");
      let settledAttempt: Awaited<ReturnType<KnowledgePipeline["ingestionRun"]>>;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        settledAttempt = await instance.ingestionRun(alice, attemptRun.runId);
        if (settledAttempt && settledAttempt.status !== "processing") break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return settledAttempt!;
    };
    let settled = await ingestOnce();
    // 上游瞬时失败（429 突发等）：同摘要幂等，安全重试一次。
    if (settled.status === "failed") settled = await ingestOnce();
    expect(settled?.status).toBe("completed");
    expect(settled?.documentId).toBeTruthy();

    // 检索（真实向量 + 真实重排）：引用字段齐备。
    const hits = await instance.retrieve(alice, "知识库的可见性语义");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toBe("m3-e2e.md");
    expect(hits[0]!.citation.snippet.length).toBeGreaterThan(0);

    // 跨用户私有拒绝（ACL 查询内过滤的实机形态）。
    expect(await instance.retrieve(bob, "知识库的可见性语义")).toHaveLength(0);

    // 归档后立即不可检索。
    const archived = await instance.archive(alice, settled!.documentId!);
    expect(archived?.status).toBe("deleted");
    expect(await instance.retrieve(alice, "知识库的可见性语义")).toHaveLength(0);

    // 清理测试数据（本 e2e 专属租户，不污染 dev 库）。
    await db.execute(`DELETE FROM knowledge_ingestion_jobs WHERE tenant_id = '${tenant}'`);
    await db.execute(`DELETE FROM knowledge_bases WHERE tenant_id = '${tenant}'`);
  }, 180_000);

  it("真实嵌入向量维度与模型对齐（1024）", async () => {
    const { apiKey } = externalE2eConfig();
    const client = new SiliconFlowEmbeddingClient({ apiKey });
    const [vector] = await client.embedTexts(["维度探测"]);
    expect(vector).toHaveLength(1024);
    expect(vector?.every((value) => Number.isFinite(value))).toBe(true);
  }, 60_000);
});
