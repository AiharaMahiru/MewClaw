import { inspectImportCredential, type AuthCapability, type AuthUserImportPlan } from "dsh-lark-auth";
import { createHash } from "node:crypto";
import {
  makeBotId,
  makeConversationId,
  makeDeploymentId,
  makeTenantId,
  makeUserId,
  type Scope,
} from "dsh-lark-contracts";
import { describe, expect, it, vi } from "vitest";

import { digestCanonical } from "./canonical-json.js";
import { assertMigrationPlanSource, createMigrationPlan, dryRunMigrationPlan } from "./planner.js";
import type {
  DoorAgentUserRecord,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationPlan,
  MigrationPolicy,
} from "./types.js";

const SNAPSHOT_DIGEST = "a".repeat(64);
const SOURCE_DIGEST_A = "b".repeat(64);
const SOURCE_DIGEST_B = "c".repeat(64);
const POLICY: MigrationPolicy = {
  allowCredentialReuse: true,
  includeAssociatedData: false,
};
const SCOPE: Scope = {
  tenantId: makeTenantId("tenant"),
  botId: makeBotId("bot"),
  deploymentId: makeDeploymentId("migration"),
  userId: makeUserId("admin-user"),
  conversationId: makeConversationId("dooragent-cutover"),
};
const ACTOR: MigrationActor = {
  scope: SCOPE,
  operator: {
    userId: SCOPE.userId,
    sessionId: "admin-session",
    requestId: "migration-request",
  },
};

describe("createMigrationPlan", () => {
  it("对乱序记录生成相同 planId、planDigest 和 runId", async () => {
    const first = makeLoaded([adminRecord(), userRecord()]);
    const second = makeLoaded([userRecord(), adminRecord()]);

    const planA = await createMigrationPlan(first, POLICY, createAuth().auth, ACTOR);
    const planB = await createMigrationPlan(second, POLICY, createAuth().auth, ACTOR);

    expect(planB).toEqual(planA);
    expect(planA.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(planA.planDigest).toBe(planA.planId);
    expect(planA.runId).toMatch(/^[a-f0-9]{64}$/);
    expect(planA.users.map((user) => user.source.sourceId)).toEqual(["admin-1", "user-1"]);
  });

  it("计划不泄漏邮箱、密码哈希或工作区路径", async () => {
    const plan = await createMigrationPlan(makeLoaded([adminRecord(), userRecord()]), POLICY, createAuth().auth, ACTOR);

    expectSensitiveValuesRedacted(plan);
  });

  it("为复用凭证的 merge 用户生成脱敏 credential-sync 候选", async () => {
    const plan = await createMigrationPlan(makeLoaded([adminRecord(), userRecord()]), POLICY, createAuth().auth, ACTOR);

    expect(plan.users[0]?.credentialSync).toBeNull();
    expect(plan.users[1]?.credentialSync).toEqual({
      source: {
        sourceSystem: "dooragent",
        sourceType: "credential",
        sourceId: "user-1",
        sourceDigest: SOURCE_DIGEST_B,
      },
      targetUserId: "existing-user",
      expectedRole: "user",
      expectedDefaultMode: "lightweight",
      expectedStatus: "active",
      credentialDigest: expectedCredentialDigest(userRecord(), "existing-user"),
      rollbackSnapshotRef: `vault:dsh/dooragent/credential-sync/${SNAPSHOT_DIGEST}/user-1`,
    });
    expect(JSON.stringify(plan.users[1]?.credentialSync)).not.toContain(userRecord().passwordEncoded);
  });

  it("验证 workspaces 字段引入前已经落盘的历史计划", async () => {
    const loaded = makeLoaded([adminRecord(), userRecord()]);
    const current = await createMigrationPlan(loaded, POLICY, createAuth().auth, ACTOR);
    const body = structuredClone(current) as Partial<MigrationPlan>;
    delete body.workspaces;
    delete body.planDigest;
    delete body.planId;
    delete body.runId;
    const planDigest = digestCanonical(body);
    const legacy = {
      ...body,
      planDigest,
      planId: planDigest,
      runId: createHash("sha256").update(`dooragent-run\0${planDigest}`, "utf8").digest("hex"),
    } as MigrationPlan;

    expect(() => assertMigrationPlanSource(legacy, loaded)).not.toThrow();
  });

  it("拒绝创建包含 DoorAgent 关联数据的新计划，且不调用 Auth", async () => {
    const loaded = makeLoaded([adminRecord(), userRecord()]);
    loaded.workspaces = [
      workspaceRecord("admin-1", "manifested", 1),
      workspaceRecord("user-1", "missing", 0),
    ];
    const auth = createAuth();

    await expect(createMigrationPlan(
      loaded,
      { ...POLICY, includeAssociatedData: true },
      auth.auth,
      ACTOR,
    )).rejects.toMatchObject({ code: "PLAN_INVALID" });

    expect(auth.dryRunUserImport).not.toHaveBeenCalled();
  });

  it("拒绝被篡改的 inventory，且不调用 Auth", async () => {
    const loaded = makeLoaded([adminRecord(), userRecord()]);
    loaded.inventory.users[0]!.sourceDigest = "f".repeat(64);
    const auth = createAuth();

    await expect(createMigrationPlan(loaded, POLICY, auth.auth, ACTOR))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(auth.dryRunUserImport).not.toHaveBeenCalled();
  });

  it("在规划阶段拒绝操作者就是 merge 目标的凭证同步", async () => {
    const auth = createAuth();
    const actor = {
      ...ACTOR,
      scope: { ...ACTOR.scope, userId: makeUserId("existing-user") },
      operator: { ...ACTOR.operator, userId: "existing-user" },
    };

    await expect(createMigrationPlan(makeLoaded([adminRecord(), userRecord()]), POLICY, auth.auth, actor))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
  });
});

describe("dryRunMigrationPlan", () => {
  it("重放只读规划并返回脱敏报告，不调用任何写入口", async () => {
    const loaded = makeLoaded([adminRecord(), userRecord()]);
    const auth = createAuth();
    const plan = await createMigrationPlan(loaded, POLICY, auth.auth, ACTOR);

    const report = await dryRunMigrationPlan(plan, loaded, auth.auth, ACTOR);

    expect(auth.dryRunUserImport).toHaveBeenCalledTimes(4);
    expect(report.counts).toEqual({
      merged: 1,
      migrated: 1,
      rejected: 0,
      resetRequired: 0,
      total: 2,
    });
    expect(report.status).toBe("ready");
    expect(report.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expectSensitiveValuesRedacted(report);
  });

  it("计划被篡改时在调用 Auth 前拒绝", async () => {
    const loaded = makeLoaded([adminRecord(), userRecord()]);
    const auth = createAuth();
    const plan = await createMigrationPlan(loaded, POLICY, auth.auth, ACTOR);
    const tampered = structuredClone(plan) as MigrationPlan;
    tampered.users[0]!.reasonCode = "tampered";
    auth.dryRunUserImport.mockClear();

    await expect(dryRunMigrationPlan(tampered, loaded, auth.auth, ACTOR))
      .rejects.toMatchObject({ code: "PLAN_INVALID" });
    expect(auth.dryRunUserImport).not.toHaveBeenCalled();
  });
});

function createAuth(): {
  auth: Pick<AuthCapability, "dryRunUserImport">;
  dryRunUserImport: ReturnType<typeof vi.fn>;
} {
  const dryRunUserImport = vi.fn(async (input: Parameters<AuthCapability["dryRunUserImport"]>[0]) => {
    const credential = input.candidate.passwordEncoded
      ? { action: "reuse" as const, algorithm: "scrypt" as const, profile: "dooragent-scrypt-v1" as const }
      : { action: "reset_required" as const, reason: "CREDENTIAL_MISSING" };
    const common = { credential, candidateDigest: digestCanonical(input.candidate) };
    const result: AuthUserImportPlan = input.candidate.role === "admin"
      ? { ...common, decision: "create" }
      : { ...common, decision: "merge", targetUserId: "existing-user" };
    return result;
  });
  return { auth: { dryRunUserImport }, dryRunUserImport };
}

function makeLoaded(records: DoorAgentUserRecord[]): LoadedDoorAgentSource {
  const users = [...records]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map(({ sourceId, sourceDigest, role, status }) => ({ sourceId, sourceDigest, role, status }));
  const content = {
    sourceSystem: "dooragent" as const,
    snapshotDigest: SNAPSHOT_DIGEST,
    manifestVersion: 4,
    counts: [{ sourceType: "user" as const, count: users.length }],
    users,
  };
  return {
    inventory: { ...content, inventoryDigest: digestCanonical(content) },
    records,
  };
}

function adminRecord(): DoorAgentUserRecord {
  return record("admin-1", "admin@example.invalid", "Admin", "admin", SOURCE_DIGEST_A);
}

function userRecord(): DoorAgentUserRecord {
  return record("user-1", "user@example.invalid", "User", "user", SOURCE_DIGEST_B);
}

function expectedCredentialDigest(record: DoorAgentUserRecord, targetUserId: string): string {
  const inspected = inspectImportCredential({ sourceSystem: "dooragent", encoded: record.passwordEncoded });
  if (inspected.action !== "reuse") throw new Error("expected reusable DoorAgent credential");
  return credentialSyncCredentialDigest({
    sourceId: record.sourceId,
    sourceDigest: record.sourceDigest,
    snapshotDigest: SNAPSHOT_DIGEST,
    targetUserId,
    expectedRole: record.role,
    expectedDefaultMode: "lightweight",
    expectedStatus: "active",
    normalizedEncoded: inspected.normalizedEncoded,
  });
}

function credentialSyncCredentialDigest(input: {
  sourceId: string;
  sourceDigest: string;
  snapshotDigest: string;
  targetUserId: string;
  expectedRole: "admin" | "user";
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  normalizedEncoded: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    source: {
      sourceSystem: "dooragent",
      sourceType: "credential",
      sourceId: input.sourceId,
      sourceDigest: input.sourceDigest,
    },
    snapshotDigest: input.snapshotDigest,
    targetUserId: input.targetUserId,
    expectedRole: input.expectedRole,
    expectedDefaultMode: input.expectedDefaultMode,
    expectedStatus: input.expectedStatus,
    normalizedEncoded: input.normalizedEncoded,
  }), "utf8").digest("hex");
}

function record(
  sourceId: string,
  email: string,
  displayName: string,
  role: "admin" | "user",
  sourceDigest: string,
): DoorAgentUserRecord {
  return {
    sourceId,
    sourceDigest,
    email,
    displayName,
    role,
    status: "active",
    passwordEncoded: `scrypt:${"d".repeat(32)}:${"e".repeat(128)}`,
    workspaceRoot: `/srv/workspaces/${sourceId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastLoginAt: null,
    userGroup: "default",
  };
}

function expectSensitiveValuesRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  expect(serialized).not.toMatch(/scrypt:[a-f0-9]{32}:[a-f0-9]{128}/i);
  expect(serialized).not.toContain("/srv/workspaces/");
}

function workspaceRecord(
  sourceUserId: string,
  status: "manifested" | "missing",
  symlinkCount: number,
) {
  return {
    sourceUserId,
    rootPathSha256: "d".repeat(64),
    sourceDigest: "e".repeat(64),
    status,
    aggregate: status === "manifested" ? {
      bytes: 0,
      directoryCount: 1,
      fileCount: 0,
      merkleRootSha256: "f".repeat(64),
      specialFileCount: 0,
      symlinkCount,
      unreadableEntries: 0,
      unstableFiles: 0,
    } : null,
    workspaceRoot: `/srv/workspaces/${sourceUserId}`,
  };
}
