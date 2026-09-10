/**
 * 摄入任务审计测试（SPEC knowledge.md §6）：创建/单调进度/完成/失败/
 * 重启恢复（recoverInterrupted）/列表与单查的 scope 过滤。
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import type { KnowledgeDatabase } from "./database.js";
import { PostgresKnowledgeIngestionService } from "./ingestion.js";
import { KNOWLEDGE_MIGRATIONS } from "./migrations.js";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
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

function scope(userId: string): Scope {
  return {
    tenantId: makeTenantId("t"),
    botId: makeBotId("b"),
    deploymentId: makeDeploymentId("d"),
    userId: makeUserId(userId),
    conversationId: makeConversationId("oc_1"),
  };
}

const INPUT = {
  visibility: "user_private" as const,
  fileName: "notes.md",
  mimeType: "text/markdown",
  sourceSize: 10,
  category: "general" as const,
  tags: ["a", "b"],
};

describe("PostgresKnowledgeIngestionService", () => {
  it("create → advance（单调）→ complete 全链路与状态落库", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const ingestions = new PostgresKnowledgeIngestionService(database);
    const alice = scope("ou_a");

    const run = await ingestions.create(alice, INPUT);
    expect(run).toMatchObject({ stage: "queued", progress: 10, status: "processing", visibility: "user_private" });
    expect(run.tags).toEqual(["a", "b"]);

    await ingestions.advance(alice, run.runId, { stage: "embedding", progress: 70 });
    // 单调约束：进度回退不生效。
    await ingestions.advance(alice, run.runId, { stage: "inspecting", progress: 20 });
    expect((await ingestions.get(alice, run.runId))!.progress).toBe(70);

    // 建真实文档（complete 的 document_id 外键指向 knowledge_documents）。
    const docId = "9f8b3b1a-0000-4000-8000-000000000000";
    await pg.exec(`
      INSERT INTO knowledge_bases (id, tenant_id, bot_id, deployment_id, visibility, owner_user_id)
      VALUES ('b1a2b3c4-0000-4000-8000-000000000000', 't', 'b', 'd', 'user_private', 'ou_a');
      INSERT INTO knowledge_documents (id, knowledge_base_id, document_key, version, source_storage_key,
        source_name, source_mime, source_sha256, source_size, status)
      VALUES ('${docId}', 'b1a2b3c4-0000-4000-8000-000000000000', 'notes', 1, 'notes.md', 'notes.md',
        'text/markdown', '${"a".repeat(64)}', 10, 'active');
    `);
    await ingestions.complete(alice, run.runId, docId);
    const done = await ingestions.get(alice, run.runId);
    expect(done).toMatchObject({ stage: "completed", progress: 100, status: "completed", documentId: docId });
  });

  it("fail 记录错误码；complete 后 fail 不生效（仅 processing 可迁移）", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const ingestions = new PostgresKnowledgeIngestionService(database);
    const alice = scope("ou_a");

    const run = await ingestions.create(alice, INPUT);
    await ingestions.fail(alice, run.runId, "UNSUPPORTED_MIME");
    const failed = await ingestions.get(alice, run.runId);
    expect(failed?.errorCode).toBe("UNSUPPORTED_MIME");
    expect(failed?.status).toBe("failed");

    await ingestions.complete(alice, run.runId, "9f8b3b1a-0000-4000-8000-000000000000");
    expect((await ingestions.get(alice, run.runId))!.status).toBe("failed"); // 不再迁移
  });

  it("list/get 按 scope 隔离（其他用户不可见任务）", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const ingestions = new PostgresKnowledgeIngestionService(database);
    const alice = scope("ou_a");
    const bob = scope("ou_b");

    const run = await ingestions.create(alice, INPUT);
    expect(await ingestions.list(alice)).toHaveLength(1);
    expect(await ingestions.list(bob)).toHaveLength(0);
    expect(await ingestions.get(bob, run.runId)).toBeUndefined();
  });

  it("recoverInterrupted：重启后遗留 processing 全部置 failed(SERVICE_RESTARTED)", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const ingestions = new PostgresKnowledgeIngestionService(database);
    const alice = scope("ou_a");

    const stuck = await ingestions.create(alice, INPUT);
    await ingestions.recoverInterrupted();
    const recovered = await ingestions.get(alice, stuck.runId);
    expect(recovered).toMatchObject({ status: "failed", errorCode: "SERVICE_RESTARTED" });
  });
});
