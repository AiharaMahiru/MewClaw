/**
 * PostgresKnowledgeStore 测试（SPEC knowledge.md §8 安全核心）：
 * PGlite + pgvector（键无关可重放），逐条验证 ACL 查询内过滤与版本语义：
 * 跨用户/跨 bot/跨租户拒绝、archive 后不可检索、同摘要幂等、
 * superseded 不返回、非所有者生命周期无效果（admin 测试域）。
 */
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { afterEach, describe, expect, it } from "vitest";

import { makeBotId, makeDeploymentId, makeTenantId, makeUserId, makeConversationId, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { contentDigest } from "./chunker.js";
import type { KnowledgeDatabase } from "./database.js";
import { KNOWLEDGE_MIGRATIONS } from "./migrations.js";
import { PostgresKnowledgeStore, type SourceDescriptor, type StoredChunk } from "./store.js";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

/** PGlite 适配（与 infra 迁移器同契约）。 */
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

/** 1024 维确定性向量（seed 派生，避免外部嵌入依赖）。 */
function embeddingOf(seed: number): number[] {
  let value = seed;
  const vector: number[] = [];
  for (let i = 0; i < 1024; i += 1) {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    vector.push((value / 4_294_967_296) * 2 - 1);
  }
  return vector;
}

function scope(userId: string, botId = "b", tenantId = "t", deploymentId = "d"): Scope {
  return {
    tenantId: makeTenantId(tenantId),
    botId: makeBotId(botId),
    deploymentId: makeDeploymentId(deploymentId),
    userId: makeUserId(userId),
    conversationId: makeConversationId("oc_1"),
  };
}

const EMBEDDING_MODEL = "test/model";

function chunk(ordinal: number, text: string, seed: number): StoredChunk {
  return { ordinal, text, embedding: embeddingOf(seed) };
}

function source(sha256: string): SourceDescriptor {
  return { storageKey: "abc.md", name: "abc.md", mime: "text/markdown", sha256, size: 10 };
}

async function activate(
  store: PostgresKnowledgeStore,
  owner: Scope,
  visibility: "user_private" | "bot_shared",
  documentKey: string,
  texts: string[] = ["第一段内容 alpha"],
  force = false,
): Promise<string> {
  const sha = contentDigest(texts.join(""));
  return store.activate({
    scope: owner,
    visibility,
    documentKey,
    source: source(sha),
    embeddingModel: EMBEDDING_MODEL,
    chunks: texts.map((text, index) => chunk(index, text, index + 1)),
    ...(force ? { force: true } : {}),
  });
}

async function search(
  store: PostgresKnowledgeStore,
  viewer: Scope,
  query: string,
  seed = 100,
): Promise<string[]> {
  const results = await store.search({
    scope: viewer,
    queryText: query,
    queryEmbedding: embeddingOf(seed),
    embeddingModel: EMBEDDING_MODEL,
    limit: 8,
  });
  return results.map((result) => result.documentId);
}

async function setup(): Promise<{ pg: PGlite; store: PostgresKnowledgeStore }> {
  const pg = await PGlite.create({ extensions: { vector } });
  databases.push(pg);
  await runMigrations(knowledgeDatabase(pg), [...KNOWLEDGE_MIGRATIONS]);
  return { pg, store: new PostgresKnowledgeStore(knowledgeDatabase(pg)) };
}

describe("PostgresKnowledgeStore", () => {
  it("跨用户私有隔离：A 的私有文档对 B 不可检索", async () => {
    const { store } = await setup();
    const alice = scope("ou_a");
    const bob = scope("ou_b");
    await activate(store, alice, "user_private", "alice-notes");

    expect(await search(store, alice, "alpha")).toHaveLength(1);
    expect(await search(store, bob, "alpha")).toHaveLength(0);
  });

  it("跨 bot / 跨租户拒绝：bot_shared 只对同部署开放", async () => {
    const { store } = await setup();
    const alice = scope("ou_a");
    await activate(store, alice, "bot_shared", "shared-notes");

    expect(await search(store, scope("ou_b"), "alpha")).toHaveLength(1); // 同部署另一用户可读
    expect(await search(store, scope("ou_b", "b2"), "alpha")).toHaveLength(0); // 跨 bot
    expect(await search(store, scope("ou_b", "b", "t2"), "alpha")).toHaveLength(0); // 跨租户
    expect(await search(store, scope("ou_b", "b", "t", "d2"), "alpha")).toHaveLength(0); // 跨部署
  });

  it("词法分支与向量分支同 ACL：检索谓词内过滤", async () => {
    const { store } = await setup();
    const alice = scope("ou_a");
    await activate(store, alice, "user_private", "notes", ["独特的词法检索关键词片段"]);
    // 查询向量远离所有 chunk（seed 差异巨大），命中只能来自词法分支。
    expect(await search(store, alice, "词法检索关键词", 999_999)).toHaveLength(1);
    expect(await search(store, scope("ou_b"), "词法检索关键词", 999_999)).toHaveLength(0);
  });

  it("同摘要幂等：重复摄入返回既有文档，不产生新版本", async () => {
    const { pg, store } = await setup();
    const alice = scope("ou_a");
    const first = await activate(store, alice, "user_private", "notes");
    const second = await activate(store, alice, "user_private", "notes");

    expect(second).toBe(first);
    const versions = await pg.query<{ version: number }>(
      "SELECT version FROM knowledge_documents WHERE document_key = 'notes'",
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1]);
  });

  it("force 重索引：新版本激活，旧版本 superseded 后不返回", async () => {
    const { store } = await setup();
    const alice = scope("ou_a");
    const first = await activate(store, alice, "user_private", "notes");
    const second = await activate(store, alice, "user_private", "notes", ["更新后的内容 beta"], true);

    expect(second).not.toBe(first);
    const hits = await search(store, alice, "alpha");
    expect(hits).toEqual([second]); // 只有新版本 active
  });

  it("文档键所有权：共享库内 B 不能用 A 的键摄入", async () => {
    const { store } = await setup();
    await activate(store, scope("ou_a"), "bot_shared", "notes");
    await expect(activate(store, scope("ou_b"), "bot_shared", "notes"))
      .rejects.toThrow(/belongs to another user/);
    // 私有库按 owner 分库：同名键互不冲突。
    await expect(activate(store, scope("ou_b"), "user_private", "notes")).resolves.toBeTruthy();
  });

  it("向量维度校验：非 1024 维拒绝激活", async () => {
    const { store } = await setup();
    await expect(store.activate({
      scope: scope("ou_a"),
      visibility: "user_private",
      documentKey: "bad",
      source: source(contentDigest("x")),
      embeddingModel: EMBEDDING_MODEL,
      chunks: [{ ordinal: 0, text: "x", embedding: [0.1, 0.2] }],
    })).rejects.toThrow(/1024/);
  });

  it("空查询拒绝；空文本块拒绝", async () => {
    const { store } = await setup();
    await expect(search(store, scope("ou_a"), "   ")).rejects.toThrow(/required/);
    await expect(activate(store, scope("ou_a"), "user_private", "notes", []))
      .rejects.toThrow(/chunk/);
  });
});

describe("PostgresKnowledgeStore · 删除语义", () => {
  it("archive（deleted）后不可检索；restore 后恢复检索", async () => {
    const { pg, store } = await setup();
    const alice = scope("ou_a");
    const id = await activate(store, alice, "user_private", "notes");

    await pg.query("UPDATE knowledge_documents SET status='deleted' WHERE id=$1", [id]);
    expect(await search(store, alice, "alpha")).toHaveLength(0);

    await pg.query("UPDATE knowledge_documents SET status='active' WHERE id=$1", [id]);
    expect(await search(store, alice, "alpha")).toHaveLength(1);
  });
});
