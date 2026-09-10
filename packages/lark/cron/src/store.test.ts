/**
 * PG 存储测试（PGlite）：创建/管理（用户边界不含 conversation）、
 * SKIP LOCKED 领取与租约、complete 租约校验、投递认领/确认。
 */
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId, type Scope } from "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { CRON_MIGRATIONS } from "./migrations.js";
import { PostgresCronStore, type CronDatabase } from "./store.js";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
});

function database(pg: PGlite): CronDatabase {
  return {
    query: (sql, params) => pg.query(sql, params),
    execute: async (sql) => { await pg.exec(sql); },
    transaction: (run) => pg.transaction(async (tx) => run({
      query: (sql, params) => tx.query(sql, params),
      execute: async (sql) => { await tx.exec(sql); },
    })),
  };
}

function scope(userId: string, conversationId = "oc_1"): Scope {
  return {
    tenantId: makeTenantId("t"),
    botId: makeBotId("b"),
    deploymentId: makeDeploymentId("d"),
    userId: makeUserId(userId),
    conversationId: makeConversationId(conversationId),
  };
}

const NOW = new Date("2026-08-20T00:00:00Z");

const SCHEDULE = { kind: "cron", expression: "0 9 * * *", timezone: "UTC" } as const;

describe("PostgresCronStore", () => {
  it("create → list/get（用户边界：跨会话同用户可见）→ pause/resume/remove", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const store = new PostgresCronStore(database(pg));
    await runMigrations(database(pg), [...CRON_MIGRATIONS]);

    const job = await store.create(scope("ou_a", "oc_chat1"), { task: "每日总结", schedule: SCHEDULE }, NOW);
    expect(job.status).toBe("active");
    expect(job.nextRunAt).toBe("2026-08-20T09:00:00.000Z");

    // 同一用户另一会话可见（管理授权边界 = 用户，不含 conversation）。
    const fromOtherChat = await store.get(scope("ou_a", "oc_chat2"), job.id);
    expect(fromOtherChat?.id).toBe(job.id);

    // 跨用户拒绝。
    expect(await store.get(scope("ou_b"), job.id)).toBeUndefined();

    const paused = await store.updateStatus(scope("ou_a"), job.id, "paused", undefined);
    expect(paused?.status).toBe("paused");
    const resumed = await store.updateStatus(scope("ou_a"), job.id, "active", new Date("2026-08-21T09:00:00Z"));
    expect(resumed?.status).toBe("active");

    expect(await store.remove(scope("ou_b"), job.id)).toBe(false);
    expect(await store.remove(scope("ou_a"), job.id)).toBe(true);
  });

  it("claimDue：SKIP LOCKED 领取 + 租约互斥；renewLease 令牌校验", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const store = new PostgresCronStore(database(pg), { createLeaseToken: () => "token-1" });
    await runMigrations(database(pg), [...CRON_MIGRATIONS]);

    const job = await store.create(scope("ou_a"), { task: "t", schedule: SCHEDULE }, NOW);
    // 直接置为到期（schedule 是未来 9 点）。
    await pg.query("UPDATE cron_jobs SET next_run_at = '2026-08-20T00:00:00Z' WHERE id = $1", [job.id]);

    const claimed = await store.claimDue(NOW, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.leaseToken).toBe("token-1");

    // 租约内不再领取（lease_until 未到）。
    expect(await store.claimDue(NOW, 10)).toHaveLength(0);

    // 错误令牌续期失败；正确令牌成功。
    expect(await store.renewLease(job.id, "wrong", NOW)).toBe(false);
    expect(await store.renewLease(job.id, "token-1", NOW)).toBe(true);
  });

  it("complete：租约令牌校验 + 执行历史 + 下次调度（endAt 到 → completed）", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const store = new PostgresCronStore(database(pg), { createLeaseToken: () => "tok" });
    await runMigrations(database(pg), [...CRON_MIGRATIONS]);

    const job = await store.create(scope("ou_a"), { task: "t", schedule: SCHEDULE }, NOW);
    await pg.query("UPDATE cron_jobs SET next_run_at = '2026-08-20T00:00:00Z' WHERE id = $1", [job.id]);
    const [claimed] = await store.claimDue(NOW, 10);

    await store.complete(claimed!, "run-1", { status: "completed", output: "结果文本" }, new Date("2026-08-20T00:00:01Z"));
    const runs = await store.listRuns(scope("ou_a"), 5);
    expect(runs).toEqual([expect.objectContaining({ runId: "run-1", status: "completed", output: "结果文本" })]);
    const after = await store.get(scope("ou_a"), job.id);
    // 测试把 next_run_at 人为提前到 00:00 使其到期；完成于 00:00:01，
    // 下一次真实调度 = 当天 09:00（after 之后的最近一次）。
    expect(after?.nextRunAt).toBe("2026-08-20T09:00:00.000Z");

    // 租约已清 → 再次 complete 抛错（令牌不复用）。
    await expect(store.complete(claimed!, "run-2", { status: "completed", output: "" }, NOW))
      .rejects.toThrow(/租约/);
  });

  it("投递：claimDeliveries 授权过滤 + ack；重复 ack 无效", async () => {
    const pg = await PGlite.create();
    databases.push(pg);
    const store = new PostgresCronStore(database(pg), { createLeaseToken: () => "dtok" });
    await runMigrations(database(pg), [...CRON_MIGRATIONS]);

    const job = await store.create(scope("ou_a"), { task: "t", schedule: SCHEDULE }, NOW);
    await pg.query("UPDATE cron_jobs SET next_run_at = '2026-08-20T00:00:00Z' WHERE id = $1", [job.id]);
    const [claimed] = await store.claimDue(NOW, 10);
    await store.complete(claimed!, "run-1", { status: "completed", output: "内容" }, NOW);

    const identity = { tenantId: "t", botId: "b", deploymentId: "d" };
    // 授权用户命中。
    const deliveries = await store.claimDeliveries({ ...identity, userIds: ["ou_a"], now: NOW, limit: 10 });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ runId: "run-1", task: "t", deliveryToken: "dtok" });

    // 非授权用户不命中。
    expect(await store.claimDeliveries({ ...identity, userIds: ["ou_b"], now: NOW, limit: 10 })).toHaveLength(0);

    expect(await store.ackDelivery("run-1", "dtok", NOW)).toBe(true);
    expect(await store.ackDelivery("run-1", "dtok", NOW)).toBe(false); // 已确认 → 幂等失败。
    expect(await store.claimDeliveries({ ...identity, userIds: ["ou_a"], now: NOW, limit: 10 })).toHaveLength(0);
  });
});
