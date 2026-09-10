import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeBotId, makeDeploymentId, makeTenantId } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import {
  CANONICAL_USER_MIGRATIONS,
  PgCanonicalUserDatabase,
  PostgresCanonicalUserResolver,
  createPostgresCanonicalUserWriter,
  type CanonicalMutationResult,
  type CanonicalUserId,
  type IdentityNamespace,
} from "./index.js";

const CONNECTION_STRING = process.env.DSH_CANONICAL_USER_TEST_DATABASE_URL;
const USER_1 = "00000000-0000-4000-8000-000000000001" as CanonicalUserId;
const USER_2 = "00000000-0000-4000-8000-000000000002" as CanonicalUserId;

interface LiveState {
  admin: Pool;
  schema: string;
  first: PgCanonicalUserDatabase;
  second: PgCanonicalUserDatabase;
}

let state: LiveState | undefined;

function namespace(): IdentityNamespace {
  return {
    tenantId: makeTenantId("tenant-live"),
    botId: makeBotId("bot-live"),
    deploymentId: makeDeploymentId("deployment-live"),
  };
}

function eventId(suffix: number): string {
  return `30000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

async function setupLive(): Promise<LiveState> {
  if (!CONNECTION_STRING) throw new Error("live PostgreSQL URL is absent");
  const url = new URL(CONNECTION_STRING);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !/test/i.test(databaseName)) {
    throw new Error("canonical-user live test requires a PostgreSQL database whose name contains test");
  }
  const schema = `canonical_user_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: CONNECTION_STRING });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const first = new PgCanonicalUserDatabase(url.toString());
  const second = new PgCanonicalUserDatabase(url.toString());
  await runMigrations(first, CANONICAL_USER_MIGRATIONS);
  return { admin, schema, first, second };
}

async function cleanupLive(current: LiveState | undefined): Promise<void> {
  if (!current) return;
  await Promise.allSettled([current.first.close(), current.second.close()]);
  await current.admin.query(`DROP SCHEMA "${current.schema}" CASCADE`);
  await current.admin.end();
}

async function assertSameIdentityConverges(current: LiveState): Promise<void> {
  const first = new PostgresCanonicalUserResolver(current.first);
  const second = new PostgresCanonicalUserResolver(current.second);
  const results = await Promise.all([
    first.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_live_shared" } }),
    second.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_live_shared" } }),
  ]);
  expect(results[0]).toEqual(results[1]);
}

async function bindWithSharedEvent(
  database: PgCanonicalUserDatabase,
  openId: string,
  userId: CanonicalUserId,
): Promise<CanonicalMutationResult> {
  return database.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
    namespace: namespace(), openId, canonicalUserId: userId, eventId: eventId(3), expectedVersion: 1,
  }));
}

async function assertGlobalEventConflict(current: LiveState): Promise<void> {
  const first = new PostgresCanonicalUserResolver(current.first);
  const second = new PostgresCanonicalUserResolver(current.second);
  await first.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_live_a" }, eventId: eventId(1) });
  await second.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_live_b" }, eventId: eventId(2) });
  const results = await Promise.all([
    bindWithSharedEvent(current.first, "ou_live_a", USER_1),
    bindWithSharedEvent(current.second, "ou_live_b", USER_2),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.filter((result) => !result.ok && result.code === "EVENT_ID_CONFLICT")).toHaveLength(1);
}

async function assertBindUnbindLinearizes(current: LiveState): Promise<void> {
  const resolver = new PostgresCanonicalUserResolver(current.first);
  await resolver.resolveForUsage({ namespace: namespace(), source: { kind: "feishu", openId: "ou_live_race" }, eventId: eventId(4) });
  const [bound, unbound] = await Promise.all([
    current.first.transaction((executor) => createPostgresCanonicalUserWriter(executor).bind({
      namespace: namespace(), openId: "ou_live_race", canonicalUserId: USER_1, eventId: eventId(5),
    })),
    current.second.transaction((executor) => createPostgresCanonicalUserWriter(executor).unbind({
      namespace: namespace(), openId: "ou_live_race", canonicalUserId: USER_1, eventId: eventId(6),
    })),
  ]);
  expect([bound, unbound].every((result) => result.ok)).toBe(true);
  const active = await current.first.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM canonical_user_bindings WHERE subject = $1 AND valid_to IS NULL",
    ["ou_live_race"],
  );
  expect(active.rows[0]?.count).toBe("1");
}

const liveDescribe = CONNECTION_STRING ? describe : describe.skip;

liveDescribe("Postgres canonical-user real concurrency", () => {
  beforeAll(async () => { state = await setupLive(); }, 30_000);
  afterAll(async () => { await cleanupLive(state); }, 30_000);

  it("两个连接验证 identity/event 锁与 active interval", async () => {
    if (!state) throw new Error("live PostgreSQL state missing");
    await assertSameIdentityConverges(state);
    await assertGlobalEventConflict(state);
    await assertBindUnbindLinearizes(state);
  }, 30_000);
});
