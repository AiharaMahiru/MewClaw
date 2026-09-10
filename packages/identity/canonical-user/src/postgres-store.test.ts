import { PGlite } from "@electric-sql/pglite";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { makeBotId, makeDeploymentId, makeTenantId } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import {
  CANONICAL_USER_TRANSACTION_EXECUTOR,
  CANONICAL_USER_MIGRATIONS,
  PostgresCanonicalUserResolver,
  createPostgresCanonicalUserWriter,
  type CanonicalUserDatabase,
  type CanonicalUserId,
  type CanonicalUserQueryResult,
  type CanonicalUserTransactionExecutor,
  type IdentityNamespace,
} from "./index.js";

const USER_1 = "00000000-0000-4000-8000-000000000001" as CanonicalUserId;
const USER_2 = "00000000-0000-4000-8000-000000000002" as CanonicalUserId;
const OPEN_ID = "ou_postgres_subject";
const NOW = "2026-08-24T00:00:00.000Z";
const PAST = "2026-08-23T00:00:00.000Z";
const databases: PGlite[] = [];

function namespace(): IdentityNamespace {
  return {
    tenantId: makeTenantId("tenant-pg"),
    botId: makeBotId("bot-pg"),
    deploymentId: makeDeploymentId("deployment-pg"),
  };
}

function eventId(suffix: number): string {
  return `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function wrap(pg: PGlite): CanonicalUserDatabase {
  return {
    query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<CanonicalUserQueryResult<Row>> => {
      const result = await pg.query<Row>(sql, params);
      return { rows: result.rows };
    },
    execute: async (sql) => { await pg.exec(sql); },
    transaction: (run) => pg.transaction(async (tx) => run({
      [CANONICAL_USER_TRANSACTION_EXECUTOR]: true,
      query: async <Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<CanonicalUserQueryResult<Row>> => {
        const result = await tx.query<Row>(sql, params);
        return { rows: result.rows };
      },
      execute: async (sql) => { await tx.exec(sql); },
    })),
    close: () => pg.close(),
  };
}

async function setup(): Promise<{ pg: PGlite; database: CanonicalUserDatabase; resolver: PostgresCanonicalUserResolver }> {
  const pg = await PGlite.create();
  databases.push(pg);
  const database = wrap(pg);
  await runMigrations(database, CANONICAL_USER_MIGRATIONS);
  await runMigrations(database, CANONICAL_USER_MIGRATIONS);
  return { pg, database, resolver: new PostgresCanonicalUserResolver(database) };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe("Postgres canonical-user", () => {
  it("拒绝把 Database 直接当作 Writer transaction executor", async () => {
    const { database } = await setup();
    expect(() => createPostgresCanonicalUserWriter(
      database as unknown as CanonicalUserTransactionExecutor,
    )).toThrow("requires a transaction executor");
  });

  it("迁移幂等且 partial unique 保证一个 active interval", async () => {
    const { pg, resolver } = await setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => resolver.resolveForUsage({
      namespace: namespace(),
      source: { kind: "feishu", openId: OPEN_ID },
    })));
    expect(new Set(results.map((item) => item.principalId))).toHaveLength(1);
    const active = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM canonical_user_bindings WHERE valid_to IS NULL");
    expect(active.rows[0]?.count).toBe(1);
  });

  it("writer 在调用方事务中完成 bind、rotate 与历史成员隔离", async () => {
    const { database, resolver } = await setup();
    const provisional = await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_1 } });
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "web", userId: USER_2 } });

    const bound = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(1), expectedVersion: 1,
    }));
    expect(bound).toMatchObject({ ok: true, resolution: { principalId: provisional.principalId, bindingVersion: 2 } });
    const unbound = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(2), expectedVersion: 2,
    }));
    if (!unbound.ok) throw new Error("expected unbind success");
    const rebound = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_2, eventId: eventId(3), expectedVersion: 3,
    }));
    expect(rebound).toMatchObject({ ok: true, resolution: { principalId: unbound.resolution.principalId, bindingVersion: 4 } });
    expect(await resolver.members({ namespace: namespace(), canonicalUserId: USER_1 })).toContain(provisional.principalId);
    expect(await resolver.members({ namespace: namespace(), canonicalUserId: USER_2 })).toContain(unbound.resolution.principalId);
  });
});

describe("Postgres canonical-user failure boundaries", () => {
  it("eventId 幂等、冲突和 expectedVersion 均 fail closed", async () => {
    const { database, resolver } = await setup();
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const command = { namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(4), expectedVersion: 1 };
    const first = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind(command));
    const replay = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind(command));
    const conflict = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({ ...command, canonicalUserId: USER_2 }));
    const stale = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind({ ...command, eventId: eventId(5), expectedVersion: 1 }));
    expect(replay).toEqual(first);
    expect(conflict).toEqual({ ok: false, code: "EVENT_ID_CONFLICT" });
    expect(stale).toEqual({ ok: false, code: "EXPECTED_VERSION_MISMATCH", currentVersion: 2 });
  });

  it("Writer 非法边界输入返回 INVALID_INPUT 且不触发 SQL 写入", async () => {
    const { pg, database, resolver } = await setup();
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    const result = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: "NOT-A-UUID", expectedVersion: 1,
    }));
    expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
    const counts = await pg.query<{ bindings: number; outbox: number }>(
      "SELECT (SELECT count(*)::int FROM canonical_user_bindings) AS bindings, (SELECT count(*)::int FROM canonical_user_outbox) AS outbox",
    );
    expect(counts.rows[0]).toEqual({ bindings: 1, outbox: 1 });
  });

  it("Writer 畸形结构返回 INVALID_INPUT 而不泄漏原生 TypeError", async () => {
    const { database } = await setup();
    const result = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: null, openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(27),
    } as never));

    expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
  });

  it("Web resolve 拒绝仅适用于飞书命令的事件字段", async () => {
    const { pg, database } = await setup();
    const resolver = new PostgresCanonicalUserResolver(database, { now: () => new Date(NOW) });
    const input = {
      namespace: namespace(), source: { kind: "web", userId: USER_1 },
      eventId: eventId(28), occurredAt: NOW,
    } as never;

    await expect(resolver.resolveForUsage(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const principals = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM canonical_user_principals");
    expect(principals.rows[0]?.count).toBe(0);
  });

  it("调用方事务回滚时业务行与 outbox 同生共死", async () => {
    const { pg, database, resolver } = await setup();
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID } });
    await expect(database.transaction(async (executor) => {
      const result = await createPostgresCanonicalUserWriter(executor).bind({
        namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(6), expectedVersion: 1,
      });
      expect(result.ok).toBe(true);
      throw new Error("force rollback");
    })).rejects.toThrow("force rollback");
    const counts = await pg.query<{
      principals: number; bindings: number; outbox: number; commands: number; claimed: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM canonical_user_principals) AS principals,
        (SELECT count(*)::int FROM canonical_user_bindings) AS bindings,
        (SELECT count(*)::int FROM canonical_user_outbox) AS outbox,
        (SELECT count(*)::int FROM canonical_user_commands) AS commands,
        (SELECT count(*)::int FROM canonical_user_principals WHERE canonical_user_id IS NOT NULL) AS claimed`,
    );
    expect(counts.rows[0]).toEqual({ principals: 1, bindings: 1, outbox: 1, commands: 1, claimed: 0 });
  });

  it("同一调用方事务拒绝第二个 Writer 命令并整体回滚", async () => {
    const { pg, database } = await setup();
    await expect(database.transaction(async (executor) => {
      await createPostgresCanonicalUserWriter(executor).bind({
        namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(29),
      });
      await createPostgresCanonicalUserWriter(executor).unbind({
        namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
        eventId: eventId(30), expectedVersion: 1,
      });
    })).rejects.toThrow("one command");
    const counts = await pg.query<{ principals: number; commands: number }>(
      `SELECT
        (SELECT count(*)::int FROM canonical_user_principals) AS principals,
        (SELECT count(*)::int FROM canonical_user_commands) AS commands`,
    );
    expect(counts.rows[0]).toEqual({ principals: 0, commands: 0 });
  });
});

describe("Postgres canonical-user command journal", () => {
  it("首次接触带 expectedVersion 时拒绝绑定并稳定重放", async () => {
    const { pg, database } = await setup();
    const command = {
      namespace: namespace(), openId: "ou_missing_versioned_pg", canonicalUserId: USER_1,
      eventId: eventId(19), expectedVersion: 1,
    };
    const first = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind(command));
    const replay = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind(command));
    expect(first).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    expect(replay).toEqual(first);
    const count = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM canonical_user_bindings");
    expect(count.rows[0]?.count).toBe(0);
  });

  it("首次接触直接 bind，missing 失败与 existing ensure 均稳定重放", async () => {
    const { database, resolver } = await setup();
    const missing = { namespace: namespace(), openId: "ou_missing_pg", canonicalUserId: USER_1, eventId: eventId(20) };
    const firstMissing = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind(missing));
    await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_missing_pg" } });
    const replayMissing = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind(missing));
    expect(firstMissing).toEqual({ ok: false, code: "IDENTITY_NOT_BOUND" });
    expect(replayMissing).toEqual(firstMissing);

    const direct = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(21),
    }));
    expect(direct).toMatchObject({ ok: true, outcome: "bound", resolution: { canonicalUserId: USER_1, bindingVersion: 1 } });
    const ensured = await resolver.resolveForUsage({
      namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID }, eventId: eventId(22),
    });
    await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(23), expectedVersion: 1,
    }));
    expect(await resolver.resolveForUsage({
      namespace: namespace(), source: { kind: "feishu", openId: OPEN_ID }, eventId: eventId(22),
    })).toEqual(ensured);
  });
});

describe("Postgres canonical-user database invariants", () => {
  it("拒绝未来时间戳，后续服务端时间命令仍可成功", async () => {
    const { pg, database } = await setup();
    const options = { now: () => new Date(NOW) };
    const future = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor, options).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(31), occurredAt: "9999-01-01T00:00:00.000Z",
    }));
    const followup = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor, options).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(32), occurredAt: PAST,
    }));

    expect(future).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(followup).toMatchObject({ ok: true, outcome: "bound" });
    const times = await pg.query<{ valid_from: string; completed_at: string }>(
      `SELECT b.valid_from::text, c.completed_at::text
       FROM canonical_user_bindings b JOIN canonical_user_commands c ON c.event_id = b.event_id`,
    );
    expect(new Date(times.rows[0]!.valid_from).toISOString()).toBe(PAST);
    expect(new Date(times.rows[0]!.completed_at).toISOString()).toBe(NOW);
  });

  it("倒序时间 fail closed，claim write-once，journal 脱敏且 members 索引存在", async () => {
    const { pg, database } = await setup();
    await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(24), occurredAt: "2026-02-01T00:00:00.000Z",
    }));
    const reversed = await database.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1,
      eventId: eventId(25), expectedVersion: 1, occurredAt: "2026-01-01T00:00:00.000Z",
    }));
    expect(reversed).toEqual({ ok: false, code: "INVALID_INPUT" });
    const active = await pg.query<{ count: number }>("SELECT count(*)::int AS count FROM canonical_user_bindings WHERE valid_to IS NULL");
    expect(active.rows[0]?.count).toBe(1);
    await expect(pg.query(
      "UPDATE canonical_user_principals SET canonical_user_id = $2 WHERE canonical_user_id = $1",
      [USER_1, USER_2],
    )).rejects.toThrow("write-once");
    const journal = await pg.query<{ value: string }>("SELECT result_json::text AS value FROM canonical_user_commands");
    expect(journal.rows.every((row) => !row.value.includes(OPEN_ID))).toBe(true);
    const indexes = await pg.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'canonical_user_principals'");
    expect(indexes.rows.map((row) => row.indexname)).toContain("canonical_user_principals_members_idx");
  });

  it("PostgreSQL 错误离开 Writer 前移除 raw subject 与 detail", async () => {
    const executor = {
      [CANONICAL_USER_TRANSACTION_EXECUTOR]: true,
      execute: async () => undefined,
      query: async () => {
        throw Object.assign(new Error(`failed row: ${OPEN_ID}`), { code: "XX000", detail: OPEN_ID });
      },
    } satisfies CanonicalUserTransactionExecutor;
    const operation = createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: OPEN_ID, canonicalUserId: USER_1, eventId: eventId(26),
    });
    await expect(operation).rejects.toThrow("PostgreSQL operation failed (XX000)");
    await expect(operation).rejects.not.toThrow(OPEN_ID);
  });
});
