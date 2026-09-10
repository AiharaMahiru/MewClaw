import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import type { BillingDatabase } from "./database.js";
import { BILLING_MIGRATIONS } from "./migrations.js";
import { PostgresBillingStore } from "./postgres-store.js";
import { withPriceIdentity } from "./pricing.js";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function database(pg: PGlite): BillingDatabase {
  return {
    query: (sql, params) => pg.query(sql, params),
    execute: async (sql) => { await pg.exec(sql); },
    transaction: (run) => pg.transaction(async (tx) => run({
      query: (sql, params) => tx.query(sql, params),
      execute: async (sql) => { await tx.exec(sql); },
    })),
    close: async () => { await pg.close(); },
  };
}

function scope(userId: string, conversationId = "oc_1", tenantId = "tenant"): Scope {
  return {
    tenantId: makeTenantId(tenantId),
    botId: makeBotId("bot"),
    deploymentId: makeDeploymentId("deployment"),
    userId: makeUserId(userId),
    conversationId: makeConversationId(conversationId),
  };
}

async function setup(): Promise<{ pg: PGlite; store: PostgresBillingStore }> {
  const pg = await PGlite.create();
  databases.push(pg);
  const db = database(pg);
  await runMigrations(db, [...BILLING_MIGRATIONS]);
  return { pg, store: new PostgresBillingStore(db) };
}

const price = withPriceIdentity("deepseek", "deepseek-chat", {
  inputMicroCreditsPerMillion: 1_000_000,
  outputMicroCreditsPerMillion: 2_000_000,
  cacheReadMicroCreditsPerMillion: 0,
  cacheWriteMicroCreditsPerMillion: 0,
  reasoningMicroCreditsPerMillion: 0,
});

function charge(input: Partial<Parameters<PostgresBillingStore["insertCharge"]>[0]> = {}) {
  const owner = scope("user-a");
  return {
    id: "",
    scope: owner,
    runId: "run-1",
    turn: 0,
    step: 0,
    provider: "deepseek",
    model: "deepseek-chat",
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    inputMicroCredits: 1_000_000,
    outputMicroCredits: 1_000_000,
    cacheReadMicroCredits: 0,
    cacheWriteMicroCredits: 0,
    reasoningMicroCredits: 0,
    totalMicroCredits: 2_000_000,
    periodStart: "2026-08-01",
    price,
    recordedAt: "2026-08-22T00:00:00.000Z",
    ...input,
  };
}

describe("PostgresBillingStore", () => {
  it("迁移后持久化价格和用户额度", async () => {
    const { store } = await setup();
    expect(await store.setPrice(price)).toEqual(price);
    expect(await store.getPrice(price.provider, price.model)).toEqual(price);

    const user = scope("user-a");
    await store.setQuotaPolicy(user, 1234);
    expect(await store.getQuotaPolicy(user)).toBe(1234);
    expect(await store.getQuotaPolicy(scope("user-b"))).toBeUndefined();
  });

  it("账本唯一键冲突返回既有行，查询按 Scope 用户过滤", async () => {
    const { store } = await setup();
    const first = await store.insertCharge(charge());
    const duplicate = await store.insertCharge(charge({ id: "00000000-0000-0000-0000-000000000002" }));
    expect(duplicate.id).toBe(first.id);

    await store.insertCharge(charge({
      id: "",
      scope: scope("user-b", "oc_2"),
      runId: "run-2",
      inputTokens: 2,
      inputMicroCredits: 1,
      totalMicroCredits: 1,
    }));

    const all = await store.listCharges({ scope: scope("admin") });
    expect(all).toHaveLength(2);
    expect(await store.listCharges({ scope: scope("admin"), userId: "user-a" })).toHaveLength(1);
    expect(await store.listCharges({ scope: scope("admin", "oc_1", "other-tenant") })).toHaveLength(0);
  });
});
