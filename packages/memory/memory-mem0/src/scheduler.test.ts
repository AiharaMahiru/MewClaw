import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import type { MemoryDatabase } from "./database.js";
import { MEMORY_MIGRATIONS } from "./migrations.js";
import { MemoryWriteScheduler } from "./scheduler.js";
import { memoryScopeIds } from "./identifiers.js";

const databases: PGlite[] = [];
const scope: Scope = {
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId("ou_scheduler"), conversationId: makeConversationId("oc_scheduler"),
};

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

afterEach(async () => {
  while (databases.length) await databases.pop()!.close();
});

describe("MemoryWriteScheduler", () => {
  it("入队后异步领取并执行，成功任务不会重复", async () => {
    const pg = await PGlite.create(); databases.push(pg);
    const db = database(pg); await runMigrations(db, [...MEMORY_MIGRATIONS]);
    const execute = vi.fn(async () => ({ op: "cube_list" as const, cubes: [] }));
    const scheduler = new MemoryWriteScheduler(db, execute, { warn: vi.fn() }, { concurrency: 1, pollIntervalMs: 10, maxAttempts: 3, leaseMs: 1_000 });
    await scheduler.start();
    await scheduler.enqueue(scope, { op: "cube_list" });
    await scheduler.drain();
    for (let index = 0; index < 20 && execute.mock.calls.length === 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(execute).toHaveBeenCalledTimes(1);
    const rows = await db.query<{ status: string; user_id: string }>("SELECT status,user_id FROM memory_write_jobs");
    expect(rows.rows[0]?.status).toBe("completed");
    expect(rows.rows[0]?.user_id).toBe(memoryScopeIds(scope).userId);
    await scheduler.stop();
  });

  it("失败任务按次数重试后标记 failed", async () => {
    const pg = await PGlite.create(); databases.push(pg);
    const db = database(pg); await runMigrations(db, [...MEMORY_MIGRATIONS]);
    const execute = vi.fn(async () => { throw new Error("temporary"); });
    const scheduler = new MemoryWriteScheduler(db, execute, { warn: vi.fn() }, { concurrency: 1, pollIntervalMs: 10, maxAttempts: 2, leaseMs: 1_000 });
    await scheduler.start(); await scheduler.enqueue(scope, { op: "cube_list" });
    for (let index = 0; index < 80; index += 1) {
      await scheduler.drain();
      const rows = await db.query<{ status: string }>("SELECT status FROM memory_write_jobs");
      if (rows.rows[0]?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(execute.mock.calls.length).toBe(2);
    expect((await db.query<{ status: string }>("SELECT status FROM memory_write_jobs")).rows[0]?.status).toBe("failed");
    await scheduler.stop();
  });
});
