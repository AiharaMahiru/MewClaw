import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { digestCanonical } from "./canonical-json.js";
import {
  MemoryMigrationRunStore,
  migrationActorDigest,
  SqliteMigrationRunStore,
} from "./migration-state.js";
import type {
  FrozenDoorAgentSource,
  MigrationActor,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationReport,
  MigrationUserResultEvent,
  RollbackReport,
} from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteMigrationRunStore", () => {
  it("重启后恢复原计划且状态文件不含用户凭证材料", () => {
    const fixture = createStoreFixture();
    const first = new SqliteMigrationRunStore(fixture.path);
    first.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    first.close();

    const second = new SqliteMigrationRunStore(fixture.path);
    expect(second.loadRun(fixture.plan.runId)).toMatchObject({
      plan: fixture.plan,
      phase: "planned",
      cutoverEpochId: null,
    });
    second.close();
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    const row = database.prepare(`
      SELECT source_json, plan_json, report_json, rollback_json FROM migration_runs
    `).get() as Record<string, unknown>;
    database.close();
    expect(Object.values(row).filter((value) => typeof value === "string").join("\n"))
      .not.toMatch(/@|scrypt:|workspaceRoot|password/i);
  });

  it("授权后固定 cutover epoch，拒绝用另一 epoch 恢复", () => {
    const fixture = createStoreFixture();
    const store = new SqliteMigrationRunStore(fixture.path);
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const lease = store.claimRun(fixture.plan.runId, "owner", 10, 30)!;
    const guard = { ...lease, nowMs: 11 };

    store.markAuthorized(fixture.plan.runId, "epoch-1", guard);

    expect(() => store.markAuthorized(fixture.plan.runId, "epoch-2", guard))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_INVALID" }));
    store.close();
  });

  it("从 v1 状态库迁移并保留原计划", () => {
    const fixture = createStoreFixture();
    createLegacyV1State(fixture);

    const store = new SqliteMigrationRunStore(fixture.path);

    expect(store.loadRun(fixture.plan.runId)).toMatchObject({
      phase: "planned",
      outboxAckedSequence: 0,
    });
    store.close();
    const database = new DatabaseSync(fixture.path, { readOnly: true });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    database.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s 拒绝不同稳定操作员复用 deterministic run 且保留原状态", (_name, factory) => {
    const fixture = createStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const otherActor = structuredClone(fixture.actor);
    otherActor.scope.userId = "other-admin" as typeof otherActor.scope.userId;
    otherActor.operator.userId = "other-admin";
    const otherKey = digestCanonical({
      actor: otherActor,
      inventoryDigest: fixture.plan.inventoryDigest,
      policyDigest: fixture.plan.policyDigest,
    });

    expect(() => store.savePlan(otherKey, otherActor, fixture.source, fixture.plan))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(store.loadRun(fixture.plan.runId)).toMatchObject({
      stateKey: fixture.key,
      actorDigest: migrationActorDigest(fixture.actor),
    });
    store.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s store 未过期时拒绝重领并使用单调 fence", (_name, factory) => {
    const fixture = createStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);

    const first = store.claimRun(fixture.plan.runId, "owner", 10, 20);
    const sameOwner = store.claimRun(fixture.plan.runId, "owner", 11, 21);
    const otherOwner = store.claimRun(fixture.plan.runId, "other", 12, 22);

    expect(first).toEqual({ owner: "owner", fence: 1 });
    expect(sameOwner).toBeUndefined();
    expect(otherOwner).toBeUndefined();
    store.releaseRun(fixture.plan.runId, { ...first!, nowMs: 20 });
    expect(store.claimRun(fixture.plan.runId, "other", 19, 29)).toBeUndefined();
    const second = store.claimRun(fixture.plan.runId, "owner", 20, 30);
    expect(second).toEqual({ owner: "owner", fence: 2 });
    expect(store.renewRun(fixture.plan.runId, first!, 20, 30)).toBe(false);
    store.releaseRun(fixture.plan.runId, { ...first!, nowMs: 21 });
    expect(store.renewRun(fixture.plan.runId, second!, 21, 40)).toBe(true);
    expect(store.renewRun(fixture.plan.runId, second!, 40, 50)).toBe(false);
    store.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s store 所有状态写入拒绝 stale lease guard", (_name, factory) => {
    const fixture = createStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const first = store.claimRun(fixture.plan.runId, "owner", 10, 20)!;
    const second = store.claimRun(fixture.plan.runId, "owner", 20, 40)!;
    const stale = { ...first, nowMs: 21 };
    const current = { ...second, nowMs: 21 };
    const report = applyReport(fixture.plan);
    const rollback = rollbackReport(fixture.plan);

    expect(() => store.bindCutoverEpoch(fixture.plan.runId, "epoch-1", stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    store.bindCutoverEpoch(fixture.plan.runId, "epoch-1", current);
    expect(() => store.markAuthorized(fixture.plan.runId, "epoch-1", stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    store.markAuthorized(fixture.plan.runId, "epoch-1", current);
    expect(() => store.saveReport(fixture.plan.runId, report, stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    store.saveReport(fixture.plan.runId, report, current);
    store.saveUserResultReceipt(userResultEvent(fixture.plan, 1), current);
    expect(() => store.markOutboxAcked(fixture.plan.runId, 1, stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    store.markOutboxAcked(fixture.plan.runId, 1, current);
    expect(() => store.markOutboxAcked(fixture.plan.runId, 1, stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(() => store.saveRollback(fixture.plan.runId, rollback, stale))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    store.saveRollback(fixture.plan.runId, rollback, current);
    store.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s store 对 report、rollback phase 与 outbox sequence 执行相同守卫", (_name, factory) => {
    const fixture = createStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const report = applyReport(fixture.plan);
    const rollback = rollbackReport(fixture.plan);
    const lease = store.claimRun(fixture.plan.runId, "owner", 10, 30)!;
    const guard = { ...lease, nowMs: 11 };

    expect(() => store.saveReport(fixture.plan.runId, report, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(() => store.saveRollback(fixture.plan.runId, rollback, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));

    store.markAuthorized(fixture.plan.runId, "epoch-1", guard);
    store.saveReport(fixture.plan.runId, report, guard);
    expect(store.loadRun(fixture.plan.runId)?.workspaceRollback).toBeNull();
    expect(store.loadRun(fixture.plan.runId)?.credentialSyncedSourceIds).toEqual([]);
    store.saveUserResultReceipt(userResultEvent(fixture.plan, 1), guard);
    store.saveUserResultReceipt(userResultEvent(fixture.plan, 2), guard);
    expect(() => store.markOutboxAcked(fixture.plan.runId, 2, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(store.markOutboxAcked(fixture.plan.runId, 1, guard).outboxAckedSequence).toBe(1);
    expect(store.markOutboxAcked(fixture.plan.runId, 1, guard).outboxAckedSequence).toBe(1);
    expect(store.markOutboxAcked(fixture.plan.runId, 2, guard).outboxAckedSequence).toBe(2);
    store.saveRollback(fixture.plan.runId, rollback, guard);
    store.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s store requires a durable receipt matching the outbox kind", (_name, factory) => {
    const fixture = createWorkspaceStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const lease = store.claimRun(fixture.plan.runId, "workspace-owner", 10, 30)!;
    const guard = { ...lease, nowMs: 11 };

    store.markAuthorized(fixture.plan.runId, "epoch-1", guard);
    store.saveReport(fixture.plan.runId, applyReport(fixture.plan), guard);
    expect(() => store.markOutboxAcked(fixture.plan.runId, 1, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    const receipt = workspaceResultEvent(fixture.plan, 1);
    store.saveObjectResultReceipt(receipt, guard);
    expect(store.markOutboxAcked(fixture.plan.runId, 1, guard, "object").outboxAckedSequence)
      .toBe(1);
    store.close();
  });

  it.each([
    ["memory", () => new MemoryMigrationRunStore()],
    ["sqlite", () => {
      const fixture = createStoreFixture();
      return new SqliteMigrationRunStore(fixture.path);
    }],
  ] as const)("%s store 持久化 credential-sync 恢复标记", (_name, factory) => {
    const fixture = createStoreFixture();
    const store = factory();
    store.savePlan(fixture.key, fixture.actor, fixture.source, fixture.plan);
    const lease = store.claimRun(fixture.plan.runId, "owner", 10, 30)!;
    const guard = { ...lease, nowMs: 11 };

    store.markAuthorized(fixture.plan.runId, "epoch-1", guard);
    expect(store.markCredentialSynced(fixture.plan.runId, "source-2", guard).credentialSyncedSourceIds)
      .toEqual(["source-2"]);
    expect(store.markCredentialSynced(fixture.plan.runId, "source-1", guard).credentialSyncedSourceIds)
      .toEqual(["source-1", "source-2"]);
    expect(store.loadRun(fixture.plan.runId)?.credentialSyncedSourceIds)
      .toEqual(["source-1", "source-2"]);
    store.close();
  });
});

it("actor 摘要忽略易变 session/request 但保留稳定 Scope", () => {
  const fixture = createStoreFixture();
  const resumed = structuredClone(fixture.actor);
  resumed.operator.sessionId = "new-session";
  resumed.operator.requestId = "new-request";
  const otherScope = structuredClone(resumed);
  otherScope.scope.conversationId = "other-cutover" as typeof otherScope.scope.conversationId;

  expect(migrationActorDigest(resumed)).toBe(migrationActorDigest(fixture.actor));
  expect(migrationActorDigest(otherScope)).not.toBe(migrationActorDigest(fixture.actor));
});

function createStoreFixture() {
  const root = mkdtempSync(join(tmpdir(), "dooragent-state-test-"));
  roots.push(root);
  const actor = {
    scope: {
      tenantId: "tenant",
      botId: "bot",
      deploymentId: "migration",
      userId: "admin",
      conversationId: "cutover",
    },
    operator: { userId: "admin", sessionId: "session", requestId: "request" },
  } as unknown as MigrationActor;
  const source: FrozenDoorAgentSource = {
    snapshotPath: "D:/immutable/dooragent",
    manifestPath: "manifest-v4.json",
    manifestDigest: "a".repeat(64),
  };
  const users = [1, 2].map((sequence) => ({
    source: {
      sourceSystem: "dooragent" as const,
      sourceType: "user" as const,
      sourceId: `source-${sequence}`,
      sourceDigest: String(sequence).repeat(64),
    },
    decision: "create" as const,
    targetUserId: null,
    credential: { action: "reset_required" as const, reason: "CREDENTIAL_MISSING" },
    candidateDigest: String(sequence + 2).repeat(64),
    credentialSync: null,
    reasonCode: null,
  }));
  const body = {
    version: 1 as const,
    sourceSystem: "dooragent" as const,
    snapshotDigest: "a".repeat(64),
    inventoryDigest: "b".repeat(64),
    policy: { allowCredentialReuse: true, includeAssociatedData: false as const },
    policyDigest: "c".repeat(64),
    users,
    workspaces: [],
  };
  const planDigest = digestCanonical(body);
  const plan: MigrationPlan = {
    ...body,
    planDigest,
    planId: planDigest,
    runId: "d".repeat(64),
  };
  return {
    actor,
    key: digestCanonical({ actor, inventoryDigest: plan.inventoryDigest, policyDigest: plan.policyDigest }),
    path: join(root, "migration-state.sqlite"),
    plan,
    source,
  };
}

function applyReport(plan: MigrationPlan): MigrationReport {
  const users = plan.users.map((planned, index) => ({
    source: planned.source,
    targetUserId: `target-${index + 1}`,
    result: "migrated" as const,
    reasonCode: null,
  }));
  const workspaces = plan.workspaces.map((planned) => ({
    source: planned.source,
    targetUserId: planned.targetUserId,
    targetWorkspaceId: "target-workspace",
    result: "migrated" as const,
    reasonCode: null,
  }));
  const body = {
    mode: "apply" as const,
    status: "complete" as const,
    runId: plan.runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    snapshotDigest: plan.snapshotDigest,
    counts: { total: users.length, migrated: users.length, merged: 0, rejected: 0, resetRequired: 0 },
    users,
    workspaceCounts: { total: workspaces.length, migrated: workspaces.length, merged: 0, rejected: 0 },
    workspaces,
  };
  return { ...body, reportDigest: digestCanonical(body) };
}

function createWorkspaceStoreFixture() {
  const fixture = createStoreFixture();
  const workspace = {
    source: {
      sourceSystem: "dooragent" as const,
      sourceType: "workspace" as const,
      sourceId: "source-1",
      sourceDigest: "e".repeat(64),
    },
    decision: "migrate" as const,
    targetUserId: "target-1",
    aggregate: null,
    candidateDigest: "f".repeat(64),
    reasonCode: null,
  };
  const planBody = {
    version: fixture.plan.version,
    sourceSystem: fixture.plan.sourceSystem,
    snapshotDigest: fixture.plan.snapshotDigest,
    inventoryDigest: fixture.plan.inventoryDigest,
    policy: fixture.plan.policy,
    policyDigest: fixture.plan.policyDigest,
    users: [],
    workspaces: [workspace],
  };
  const planDigest = digestCanonical(planBody);
  const plan = { ...planBody, planDigest, planId: planDigest, runId: "e".repeat(64) };
  return {
    ...fixture,
    plan,
    key: digestCanonical({ actor: fixture.actor, inventoryDigest: plan.inventoryDigest, policyDigest: plan.policyDigest }),
  };
}

function workspaceResultEvent(plan: MigrationPlan, sequence: number): MigrationObjectResultEvent {
  const workspace = plan.workspaces[0];
  if (!workspace) throw new Error("missing fixture workspace");
  return {
    eventId: "00000000-0000-4000-8000-000000000003",
    runId: plan.runId,
    planId: plan.planId,
    cutoverEpochId: "epoch-1",
    snapshotDigest: plan.snapshotDigest,
    sequence,
    occurredAt: "2026-08-24T07:00:03.000Z",
    ignorable: false,
    source: workspace.source,
    targetUserId: "target-1",
    targetResourceId: "target-workspace",
    result: "claimed",
    reasonCode: null,
  };
}

function userResultEvent(plan: MigrationPlan, sequence: number): MigrationUserResultEvent {
  const planned = plan.users[sequence - 1];
  if (!planned) throw new Error("missing fixture user");
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    runId: plan.runId,
    planId: plan.planId,
    cutoverEpochId: "epoch-1",
    snapshotDigest: plan.snapshotDigest,
    sequence,
    occurredAt: `2026-08-24T07:00:0${sequence}.000Z`,
    ignorable: false,
    source: planned.source,
    targetUserId: `target-${sequence}`,
    result: "migrated",
    reasonCode: null,
  };
}

function rollbackReport(plan: MigrationPlan): RollbackReport {
  const body = {
    runId: plan.runId,
    planId: plan.planId,
    snapshotDigest: plan.snapshotDigest,
    rolledBack: 0,
    retained: 0,
    rejected: 0,
    reasonCode: null,
    result: "complete" as const,
    workspaceCounts: { total: 0, rolledBack: 0, retained: 0, rejected: 0 },
    workspaces: [],
  };
  return { ...body, reportDigest: digestCanonical(body) };
}

function createLegacyV1State(fixture: ReturnType<typeof createStoreFixture>): void {
  const database = new DatabaseSync(fixture.path);
  database.exec(`
    CREATE TABLE migration_runs (
      state_key TEXT PRIMARY KEY,
      run_id TEXT UNIQUE NOT NULL,
      actor_digest TEXT NOT NULL,
      source_json TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      phase TEXT NOT NULL,
      cutover_epoch_id TEXT,
      report_json TEXT,
      rollback_json TEXT,
      lease_owner TEXT,
      lease_expires_at INTEGER
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  database.prepare(`
    INSERT INTO migration_runs
      (state_key, run_id, actor_digest, source_json, plan_json, phase)
    VALUES (?, ?, ?, ?, ?, 'planned')
  `).run(
    fixture.key,
    fixture.plan.runId,
    digestCanonical(fixture.actor),
    JSON.stringify(fixture.source),
    JSON.stringify(fixture.plan),
  );
  database.close();
}
