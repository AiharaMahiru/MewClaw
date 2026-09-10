import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { digestCanonical } from "./canonical-json.js";
import {
  MemoryMigrationRunStore,
  type MigrationRunStore,
  SqliteMigrationRunStore,
} from "./migration-state.js";
import type {
  FrozenDoorAgentSource,
  MigrationActor,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationReport,
  MigrationUserResultEvent,
} from "./types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["memory", "sqlite"] as const)("%s migration result receipts", (kind) => {
  it("先持久化 receipt 才允许 checkpoint，并拒绝 payload 与 sequence 漂移", () => {
    const fixture = createFixture(kind);
    const guard = prepareCompleteRun(fixture.store, fixture);

    expect(() => fixture.store.markOutboxAcked(fixture.plan.runId, 1, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));

    const first = fixture.store.saveUserResultReceipt(fixture.event, guard);
    const repeated = fixture.store.saveUserResultReceipt(fixture.event, { ...guard, nowMs: 12 });

    expect(first).toEqual({
      event: fixture.event,
      payloadDigest: digestCanonical(fixture.event),
      recordedAtMs: 11,
    });
    expect(repeated).toEqual(first);
    expect(fixture.store.loadUserResultReceipt(fixture.event.eventId)).toEqual(first);
    expect(fixture.store.markOutboxAcked(fixture.plan.runId, 1, guard).outboxAckedSequence).toBe(1);

    const drifted = { ...fixture.event, targetUserId: "other-user" };
    expect(() => fixture.store.saveUserResultReceipt(drifted, guard))
      .toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    expect(() => fixture.store.saveUserResultReceipt({
      ...fixture.event,
      eventId: "00000000-0000-4000-8000-000000000002",
    }, guard)).toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    fixture.store.close();
  });

  it("幂等命中也拒绝 stale fence", () => {
    const fixture = createFixture(kind);
    const guard = prepareCompleteRun(fixture.store, fixture);
    fixture.store.saveUserResultReceipt(fixture.event, guard);

    expect(() => fixture.store.saveUserResultReceipt(fixture.event, {
      owner: guard.owner,
      fence: guard.fence + 1,
      nowMs: guard.nowMs,
    })).toThrowError(expect.objectContaining({ code: "PLAN_INVALID" }));
    fixture.store.close();
  });
});

it("SQLite v5 重启后保留完整脱敏 receipt", () => {
  const fixture = createFixture("sqlite");
  const guard = prepareCompleteRun(fixture.store, fixture);
  const expected = fixture.store.saveUserResultReceipt(fixture.event, guard);
  fixture.store.close();

  const resumed = new SqliteMigrationRunStore(fixture.path!);
  expect(resumed.loadUserResultReceipt(fixture.event.eventId)).toEqual(expected);
  resumed.close();

  const database = new DatabaseSync(fixture.path!, { readOnly: true });
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  const row = database.prepare(`
    SELECT payload_json FROM migration_user_result_receipts
  `).get() as { payload_json: string };
  database.close();
  expect(row.payload_json).not.toMatch(/@|scrypt:|password|workspace|token|cookie|approval|lease/i);
});

describe.each(["memory", "sqlite"] as const)("%s workspace object result receipts", (kind) => {
  it("在 Auth ack 前持久化对象结果，并支持重启读取", () => {
    const fixture = createObjectFixture(kind);
    const guard = prepareCompleteRun(fixture.store, fixture);
    const expected = fixture.store.saveObjectResultReceipt(fixture.event, guard);

    expect(fixture.store.loadObjectResultReceipt(fixture.event.eventId)).toEqual(expected);
    expect(fixture.store.markOutboxAcked(fixture.plan.runId, 1, guard, "object")
      .outboxAckedSequence).toBe(1);
    fixture.store.close();

    if (fixture.path) {
      const resumed = new SqliteMigrationRunStore(fixture.path);
      expect(resumed.loadObjectResultReceipt(fixture.event.eventId)).toEqual(expected);
      resumed.close();
      const database = new DatabaseSync(fixture.path, { readOnly: true });
      const row = database.prepare("SELECT payload_json FROM migration_object_result_receipts").get() as {
        payload_json: string;
      };
      database.close();
      expect(row.payload_json).not.toMatch(/D:\/|resourcePath|token|cookie|approval|lease/i);
    }
  });
});

it("SQLite pre-v5 状态库重启后补建 object receipt schema", () => {
  const fixture = createObjectFixture("sqlite");
  const guard = prepareCompleteRun(fixture.store, fixture);
  fixture.store.close();

  const legacy = new DatabaseSync(fixture.path!);
  legacy.exec(`
    DROP TABLE migration_object_result_receipts;
    PRAGMA user_version = 4;
  `);
  legacy.close();

  const resumed = new SqliteMigrationRunStore(fixture.path!);
  const expected = resumed.saveObjectResultReceipt(fixture.event, guard);
  expect(resumed.loadObjectResultReceipt(fixture.event.eventId)).toEqual(expected);
  resumed.close();

  const database = new DatabaseSync(fixture.path!, { readOnly: true });
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_object_result_receipts'
  `).get()).toEqual({ name: "migration_object_result_receipts" });
  database.close();
});

function prepareCompleteRun(
  store: MigrationRunStore,
  fixture: {
    event: { cutoverEpochId: string };
    plan: MigrationPlan;
    report: MigrationReport;
    actor: MigrationActor;
    source: FrozenDoorAgentSource;
    stateKey: string;
  },
) {
  store.savePlan(fixture.stateKey, fixture.actor, fixture.source, fixture.plan);
  const lease = store.claimRun(fixture.plan.runId, "receipt-owner", 10, 50)!;
  const guard = { ...lease, nowMs: 11 };
  store.bindCutoverEpoch(fixture.plan.runId, fixture.event.cutoverEpochId, guard);
  store.markAuthorized(fixture.plan.runId, fixture.event.cutoverEpochId, guard);
  store.saveReport(fixture.plan.runId, fixture.report, guard);
  return guard;
}

function createFixture(kind: "memory" | "sqlite") {
  const source: FrozenDoorAgentSource = {
    snapshotPath: "D:/immutable/dooragent",
    manifestPath: "manifest-v4.json",
    manifestDigest: "a".repeat(64),
  };
  const actor = {
    scope: { tenantId: "tenant", botId: "bot", deploymentId: "migration",
      userId: "admin", conversationId: "cutover" },
    operator: { userId: "admin", sessionId: "session", requestId: "request" },
  } as unknown as MigrationActor;
  const user = {
    source: { sourceSystem: "dooragent" as const, sourceType: "user" as const,
      sourceId: "source-user", sourceDigest: "b".repeat(64) },
    decision: "create" as const,
    targetUserId: null,
    credential: { action: "reset_required" as const, reason: "CREDENTIAL_MISSING" },
    candidateDigest: "c".repeat(64),
    credentialSync: null,
    reasonCode: null,
  };
  const plan: MigrationPlan = {
    version: 1, sourceSystem: "dooragent", snapshotDigest: source.manifestDigest,
    inventoryDigest: "d".repeat(64), policy: { allowCredentialReuse: false, includeAssociatedData: false },
    policyDigest: "e".repeat(64), users: [user], workspaces: [], planDigest: "f".repeat(64),
    planId: "1".repeat(64), runId: "2".repeat(64),
  };
  const reportUser = { source: user.source, targetUserId: "target-user" as string | null,
    result: "migrated" as const, reasonCode: null };
  const report: MigrationReport = {
    mode: "apply", status: "complete", runId: plan.runId, planId: plan.planId,
    planDigest: plan.planDigest, snapshotDigest: plan.snapshotDigest,
    counts: { total: 1, migrated: 1, merged: 0, rejected: 0, resetRequired: 0 },
    users: [reportUser], workspaceCounts: { total: 0, migrated: 0, merged: 0, rejected: 0 },
    workspaces: [], reportDigest: "3".repeat(64),
  };
  const event: MigrationUserResultEvent = {
    eventId: "00000000-0000-4000-8000-000000000001",
    runId: plan.runId, planId: plan.planId, cutoverEpochId: "cutover-epoch",
    snapshotDigest: plan.snapshotDigest, sequence: 1,
    occurredAt: "2026-08-24T07:00:01.000Z", ignorable: false, ...reportUser,
  };
  let path: string | undefined;
  let store: MigrationRunStore;
  if (kind === "memory") {
    store = new MemoryMigrationRunStore();
  } else {
    const root = mkdtempSync(join(tmpdir(), "dooragent-receipt-test-"));
    roots.push(root);
    path = join(root, "migration-state.sqlite");
    store = new SqliteMigrationRunStore(path);
  }
  return { actor, event, path, plan, report, source, stateKey: "4".repeat(64), store };
}

function createObjectFixture(kind: "memory" | "sqlite") {
  const base = createFixture(kind);
  const workspace = {
    source: {
      sourceSystem: "dooragent" as const,
      sourceType: "workspace" as const,
      sourceId: "source-workspace",
      sourceDigest: "b".repeat(64),
    },
    decision: "migrate" as const,
    targetUserId: "target-user",
    aggregate: null,
    candidateDigest: "c".repeat(64),
    reasonCode: null,
  };
  const planBody = { ...base.plan, users: [], workspaces: [workspace] };
  const planDigest = digestCanonical(planBody);
  const plan: MigrationPlan = {
    ...planBody,
    planDigest,
    planId: planDigest,
    runId: "6".repeat(64),
  };
  const reportBody = {
    ...base.report,
    runId: plan.runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    users: [],
    counts: { total: 0, migrated: 0, merged: 0, rejected: 0, resetRequired: 0 },
    workspaces: [{
      source: workspace.source,
      targetUserId: "target-user",
      targetWorkspaceId: "target-workspace",
      result: "migrated" as const,
      reasonCode: null,
    }],
    workspaceCounts: { total: 1, migrated: 1, merged: 0, rejected: 0 },
  };
  const report: MigrationReport = { ...reportBody, reportDigest: digestCanonical(reportBody) };
  const event: MigrationObjectResultEvent = {
    eventId: "00000000-0000-4000-8000-000000000004",
    runId: plan.runId,
    planId: plan.planId,
    cutoverEpochId: "cutover-epoch",
    snapshotDigest: plan.snapshotDigest,
    sequence: 1,
    occurredAt: "2026-08-24T07:00:01.000Z",
    ignorable: false,
    source: workspace.source,
    targetUserId: "target-user",
    targetResourceId: "target-workspace",
    result: "claimed",
    reasonCode: null,
  };
  return { ...base, event, plan, report };
}
