import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";

import { MemoryGraphStore } from "./graph.js";
import type { MemoryDatabase } from "./database.js";
import { MEMORY_MIGRATIONS } from "./migrations.js";
import { runMigrations } from "dsh-lark-postgres-runtime";
import { memoryScopeIds } from "./identifiers.js";

const databases: PGlite[] = [];

function scope(user: string, conversation = "oc_memory"): Scope {
  return {
    tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
    userId: makeUserId(user), conversationId: makeConversationId(conversation),
  };
}

function database(pg: PGlite): MemoryDatabase {
  return {
    query: (sql, params) => pg.query(sql, params as unknown[]),
    execute: async (sql) => { await pg.exec(sql); },
    transaction: async (run) => {
      await pg.exec("BEGIN");
      try { const result = await run({ query: (sql, params) => pg.query(sql, params as unknown[]), execute: async (sql) => { await pg.exec(sql); } }); await pg.exec("COMMIT"); return result; }
      catch (error) { await pg.exec("ROLLBACK"); throw error; }
    },
    close: async () => { await pg.close(); },
  } as MemoryDatabase;
}

async function setup(mem0?: ConstructorParameters<typeof MemoryGraphStore>[1]): Promise<{ store: MemoryGraphStore; pg: PGlite }> {
  const pg = await PGlite.create();
  databases.push(pg);
  const db = database(pg);
  await runMigrations(db, [...MEMORY_MIGRATIONS]);
  return { store: new MemoryGraphStore(db, mem0, { warn: () => undefined }), pg };
}

afterEach(async () => {
  while (databases.length) await databases.pop()!.close();
});

describe("MemoryGraphStore", () => {
  it("图节点按完整 Scope 隔离，Cube/边/更新可审计", async () => {
    const { store } = await setup();
    const alice = scope("ou_alice");
    const bob = scope("ou_bob");
    const created = await store.execute(alice, { op: "create", node: { kind: "preference", parts: [{ modality: "text", text: "喜欢 Maple Mono" }] } });
    expect(created.op).toBe("created");
    if (created.op !== "created") throw new Error("expected created");
    expect((await store.execute(bob, { op: "read", id: created.node.id })).op).toBe("read");
    const bobSearch = await store.execute(bob, { op: "search", query: "Maple" });
    expect(bobSearch.op === "search" ? bobSearch.nodes : []).toHaveLength(0);
    const updated = await store.execute(alice, { op: "update", id: created.node.id, expectedRevision: 1, patch: { parts: [{ modality: "text", text: "喜欢 Maple Mono NF CN" }] } });
    expect(updated.op).toBe("updated");
    await expect(store.execute(alice, { op: "update", id: created.node.id, expectedRevision: 1, patch: { parts: [{ modality: "text", text: "过期 revision" }] } })).rejects.toThrow("MEMORY_REVISION_CONFLICT");
    const second = await store.execute(alice, { op: "create", node: { kind: "fact", parts: [{ modality: "text", text: "这是一个事实" }] } });
    if (second.op !== "created" || updated.op !== "updated") throw new Error("expected nodes");
    const edge = await store.execute(alice, { op: "link", edge: { fromId: created.node.id, toId: second.node.id, relation: "supports" } });
    expect(edge.op).toBe("linked");
    const read = await store.execute(alice, { op: "read", id: created.node.id, includeEdges: true });
    expect(read.op === "read" && read.edges).toHaveLength(1);
  });

  it("Cube 成员显式共享，非成员不可见", async () => {
    const { store } = await setup();
    const alice = scope("ou_alice");
    const bob = scope("ou_bob");
    const cube = await store.execute(alice, { op: "cube_create", cube: { key: "project-x", name: "Project X", visibility: "project_shared", members: [{ userId: bob.userId, role: "viewer" }] } });
    expect(cube.op).toBe("cube_created");
    if (cube.op !== "cube_created") throw new Error("expected cube");
    const node = await store.execute(alice, { op: "create", node: { cubeId: cube.cube.id, kind: "document", parts: [{ modality: "text", text: "共享项目事实" }] } });
    expect(node.op).toBe("created");
    const visible = await store.execute(bob, { op: "search", query: "共享项目" });
    expect(visible.op === "search" && visible.nodes).toHaveLength(1);
    await expect(store.execute(bob, { op: "update", id: node.op === "created" ? node.node.id : "bad" as never, patch: { parts: [{ modality: "text", text: "越权" }] } })).rejects.toThrow("MEMORY_NOT_FOUND");
  });

  it("自然语言反馈可纠正和遗忘", async () => {
    const { store } = await setup();
    const alice = scope("ou_alice");
    const created = await store.execute(alice, { op: "create", node: { kind: "profile", parts: [{ modality: "text", text: "我的称呼是小明" }] } });
    expect(created.op).toBe("created");
    const corrected = await store.feedback(alice, "更正 我的称呼 为 小王");
    expect(corrected).toMatchObject({ op: "feedback", result: "updated", node: { parts: [{ modality: "text", text: "小王" }] } });
    const forgotten = await store.feedback(alice, "忘记 我的称呼");
    expect(forgotten.op).toBe("feedback");
  });

  it("语义近邻超过一个时仍优先唯一词法反馈目标", async () => {
    const targetIds: string[] = [];
    const mem0 = {
      add: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async () => ({ results: targetIds.map((id) => ({ memory: "nearby", metadata: { memory_node_id: id } })) })),
    };
    const { store } = await setup(mem0);
    const alice = scope("ou_feedback_noise");
    const target = await store.execute(alice, { op: "create", node: { kind: "profile", parts: [{ modality: "text", text: "我的称呼是小明" }] } });
    const distractor = await store.execute(alice, { op: "create", node: { kind: "preference", parts: [{ modality: "text", text: "偏好浅色主题" }] } });
    if (target.op !== "created" || distractor.op !== "created") throw new Error("expected feedback nodes");
    targetIds.push(target.node.id, distractor.node.id);

    const corrected = await store.feedback(alice, "更正 我的称呼 为 小王");
    expect(corrected).toMatchObject({ op: "feedback", result: "updated", node: { id: target.node.id, parts: [{ modality: "text", text: "小王" }] } });
    const forgotten = await store.feedback(alice, "忘记 小王");
    expect(forgotten).toMatchObject({ op: "feedback", result: "deleted" });
  });

  it("持久化用户键不落明文，删除同步回收语义索引", async () => {
    const remove = vi.fn(async () => undefined);
    const mem0 = {
      add: vi.fn(async () => [{ id: "mem0-node" }]),
      delete: remove,
      search: vi.fn(async () => ({ results: [] })),
    };
    const { store, pg } = await setup(mem0);
    const alice = scope("ou_alice");
    const created = await store.execute(alice, { op: "create", node: { kind: "fact", parts: [{ modality: "text", text: "private" }] } });
    if (created.op !== "created") throw new Error("expected node");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = await pg.query<{ author_user_id: string; owner_user_id: string; member_user_id: string }>(
      `SELECT n.author_user_id,c.owner_user_id,cm.user_id AS member_user_id
       FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id JOIN memory_cube_members cm ON cm.cube_id=c.id`,
    );
    expect(rows.rows[0]?.author_user_id).toBe(memoryScopeIds(alice).userId);
    expect(rows.rows[0]?.owner_user_id).toBe(memoryScopeIds(alice).userId);
    expect(rows.rows[0]?.member_user_id).toBe(memoryScopeIds(alice).userId);
    await store.execute(alice, { op: "delete", id: created.node.id });
    expect(remove).toHaveBeenCalledWith("mem0-node");
  });

  it("共享 Cube 的语义召回按 agent 索引检索，再由 SQL ACL 过滤", async () => {
    const mem0 = {
      add: vi.fn(async () => []),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async (_query: string) => ({ results: [{ memory: "共享", metadata: { memory_node_id: "00000000-0000-4000-8000-000000000099" } }] })),
    };
    const { store, pg } = await setup(mem0);
    const alice = scope("ou_alice");
    const bob = scope("ou_bob");
    const cube = await store.execute(alice, { op: "cube_create", cube: { key: "semantic-share", name: "语义共享", visibility: "project_shared", members: [{ userId: bob.userId, role: "viewer" }] } });
    if (cube.op !== "cube_created") throw new Error("expected cube");
    const node = await store.execute(alice, { op: "create", node: { cubeId: cube.cube.id, kind: "fact", parts: [{ modality: "text", text: "原文不会匹配" }] } });
    if (node.op !== "created") throw new Error("expected node");
    await pg.query("UPDATE memory_nodes SET id='00000000-0000-4000-8000-000000000099' WHERE id=$1", [node.node.id]);
    const result = await store.execute(bob, { op: "search", query: "语义命中" });
    expect(result.op === "search" ? result.nodes : []).toHaveLength(1);
    expect(mem0.search).toHaveBeenCalledWith("语义命中", { filters: { agent_id: expect.any(String) }, topK: 16 });
  });
});
