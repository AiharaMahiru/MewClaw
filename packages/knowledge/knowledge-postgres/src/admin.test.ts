/**
 * PostgresKnowledgeAdminService 测试（SPEC knowledge.md §8 管理面）：
 * snapshot 计数、canManage、非所有者写操作无效果（返回 undefined）、
 * restore/moveVisibility 事务语义（跨库迁移 + 升版本）。
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import type { DocumentId } from "dsh-knowledge";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { PostgresKnowledgeAdminService } from "./admin.js";
import { contentDigest } from "./chunker.js";
import type { KnowledgeDatabase } from "./database.js";
import { KNOWLEDGE_MIGRATIONS } from "./migrations.js";
import { PostgresKnowledgeStore } from "./store.js";

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

function embeddingOf(seed: number): number[] {
  let value = seed;
  const vector: number[] = [];
  for (let i = 0; i < 1024; i += 1) {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    vector.push((value / 4_294_967_296) * 2 - 1);
  }
  return vector;
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

async function activate(
  store: PostgresKnowledgeStore,
  owner: Scope,
  visibility: "user_private" | "bot_shared",
  documentKey: string,
  text = "内容片段",
): Promise<DocumentId> {
  return store.activate({
    scope: owner,
    visibility,
    documentKey,
    source: { storageKey: `${documentKey}.md`, name: `${documentKey}.md`, mime: "text/markdown", sha256: contentDigest(text), size: 10 },
    embeddingModel: "test/model",
    chunks: [{ ordinal: 0, text, embedding: embeddingOf(1) }],
    metadata: { sourceChannel: "admin", category: "general", tags: ["tag1"] },
  }) as Promise<DocumentId>;
}

describe("PostgresKnowledgeAdminService", () => {
  it("snapshot：可见性过滤 + 汇总计数 + canManage", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const store = new PostgresKnowledgeStore(database);
    const admin = new PostgresKnowledgeAdminService(database);
    const alice = scope("ou_a");
    const bob = scope("ou_b");

    const privateDoc = await activate(store, alice, "user_private", "a-private");
    await activate(store, alice, "bot_shared", "a-shared");

    const snapshotForAlice = await admin.snapshot(alice);
    expect(snapshotForAlice.documents).toHaveLength(2);
    expect(snapshotForAlice.summary).toMatchObject({
      activeDocuments: 2,
      privateDocuments: 1,
      sharedDocuments: 1,
    });
    const privateView = snapshotForAlice.documents.find((doc) => doc.docId === privateDoc)!;
    expect(privateView.canManage).toBe(true);
    expect(privateView.tags).toEqual(["tag1"]);

    // B 只见共享文档，且无管理权。
    const snapshotForBob = await admin.snapshot(bob);
    expect(snapshotForBob.documents).toHaveLength(1);
    expect(snapshotForBob.documents[0]!.visibility).toBe("bot_shared");
    expect(snapshotForBob.documents[0]!.canManage).toBe(false);
  });

  it("非所有者 archive/restore/moveVisibility 返回 undefined（无效果）", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const store = new PostgresKnowledgeStore(database);
    const admin = new PostgresKnowledgeAdminService(database);
    const alice = scope("ou_a");
    const bob = scope("ou_b");

    const docId = await activate(store, alice, "bot_shared", "shared");
    expect(await admin.archive(bob, docId)).toBeUndefined();
    expect(await admin.restore(bob, docId)).toBeUndefined();
    expect(await admin.moveVisibility(bob, docId, "user_private")).toBeUndefined();
    // 所有者操作有效。
    const archived = await admin.archive(alice, docId);
    expect(archived?.status).toBe("deleted");
  });

  it("restore 事务：恢复时旧 active 被取代", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const store = new PostgresKnowledgeStore(database);
    const admin = new PostgresKnowledgeAdminService(database);
    const alice = scope("ou_a");

    const v1 = await activate(store, alice, "user_private", "notes", "v1");
    const v2 = await store.activate({
      scope: alice,
      visibility: "user_private",
      documentKey: "notes",
      source: { storageKey: "notes.md", name: "notes.md", mime: "text/markdown", sha256: contentDigest("v2"), size: 2 },
      embeddingModel: "test/model",
      chunks: [{ ordinal: 0, text: "v2", embedding: embeddingOf(2) }],
      force: true,
    });
    await admin.archive(alice, v2 as DocumentId);

    const restored = await admin.restore(alice, v2 as DocumentId);
    expect(restored?.status).toBe("active");
    const v1View = await admin.get(alice, v1);
    expect(v1View?.status).toBe("superseded");
  });

  it("moveVisibility：跨库迁移 + 版本递增，目标库可见", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const store = new PostgresKnowledgeStore(database);
    const admin = new PostgresKnowledgeAdminService(database);
    const alice = scope("ou_a");
    const bob = scope("ou_b");

    const docId = await activate(store, alice, "user_private", "notes");
    expect((await admin.get(bob, docId))).toBeUndefined();

    const moved = await admin.moveVisibility(alice, docId, "bot_shared");
    expect(moved?.visibility).toBe("bot_shared");
    expect(moved?.version).toBe(1); // 目标库首版本
    expect(await admin.get(bob, docId)).toBeDefined(); // 共享后 B 可见

    const movedBack = await admin.moveVisibility(alice, docId, "user_private");
    expect(movedBack?.visibility).toBe("user_private");
    expect(await admin.get(bob, docId)).toBeUndefined(); // 回私有后 B 不可见
  });

  it("reindexSource：返回原始源描述（仅创建者）", async () => {
    const pg = await PGlite.create({ extensions: { vector } });
    databases.push(pg);
    const database = knowledgeDatabase(pg);
    await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
    const store = new PostgresKnowledgeStore(database);
    const admin = new PostgresKnowledgeAdminService(database);
    const alice = scope("ou_a");
    const bob = scope("ou_b");

    const docId = await activate(store, alice, "user_private", "notes");
    const source = await admin.reindexSource(alice, docId);
    expect(source).toMatchObject({
      sourcePath: "notes.md",
      documentKey: "notes",
      category: "general",
      tags: ["tag1"],
    });
    expect(await admin.reindexSource(bob, docId)).toBeUndefined();
  });
});
