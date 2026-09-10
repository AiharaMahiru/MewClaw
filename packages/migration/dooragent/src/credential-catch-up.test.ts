import type { AuthCapability } from "dsh-lark-auth";
import { describe, expect, it, vi } from "vitest";

import { catchUpCredentials } from "./credential-catch-up.js";
import type {
  DoorAgentUserRecord,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationPlan,
  MigrationReport,
} from "./types.js";

const SNAPSHOT_DIGEST = "a".repeat(64);

describe("credential catch-up", () => {
  it("从旧 plan 和 apply report 重建 create/merge 用户的凭证同步", async () => {
    const fixture = makeFixture();

    const result = await catchUpCredentials(fixture.input);

    expect(result).toMatchObject({ eligible: 2, processed: 2, alreadyProcessed: 0 });
    expect(fixture.issueImportApproval).toHaveBeenCalledTimes(2);
    expect(fixture.syncCredential.mock.calls.map(([input]) => input.targetUserId))
      .toEqual(["created-target", "merged-target"]);
    expect(fixture.markSynced.mock.calls.map(([sourceId]) => sourceId))
      .toEqual(["admin-1", "user-1"]);
  });

  it("重启后跳过 state 中已完成的 source user", async () => {
    const fixture = makeFixture(new Set(["admin-1", "user-1"]));

    const result = await catchUpCredentials(fixture.input);

    expect(result).toMatchObject({ eligible: 2, processed: 0, alreadyProcessed: 2 });
    expect(fixture.issueImportApproval).not.toHaveBeenCalled();
    expect(fixture.syncCredential).not.toHaveBeenCalled();
    expect(fixture.markSynced).not.toHaveBeenCalled();
  });

  it("远端成功但 checkpoint 失败后可重新同步并补记账", async () => {
    const fixture = makeFixture(new Set(["admin-1"]));
    fixture.markSynced.mockImplementationOnce(() => { throw new Error("checkpoint failed"); });

    await expect(catchUpCredentials(fixture.input)).rejects.toThrow("checkpoint failed");
    expect(fixture.syncCredential).toHaveBeenCalledOnce();
    fixture.syncCredential.mockResolvedValueOnce({
      result: "synced",
      userId: "merged-target",
      revokedSessionCount: 0,
    });

    const result = await catchUpCredentials(fixture.input);

    expect(result).toMatchObject({ eligible: 2, processed: 1, alreadyProcessed: 1 });
    expect(fixture.syncCredential).toHaveBeenCalledTimes(2);
    expect(fixture.markSynced).toHaveBeenCalledTimes(2);
  });

  it("允许 Auth 对 operator 自身做无写入等价确认", async () => {
    const fixture = makeFixture();
    fixture.input.actor.operator.userId = "created-target";
    fixture.input.actor.scope.userId = "created-target" as never;

    await expect(catchUpCredentials(fixture.input)).resolves.toMatchObject({ processed: 2 });
    expect(fixture.syncCredential).toHaveBeenCalledTimes(2);
  });
});

function makeFixture(syncedSourceIds: ReadonlySet<string> = new Set()) {
  const issueImportApproval = vi.fn(async () => ({
    approvalRef: "approval-secret",
    expiresAt: "2026-08-24T01:00:00.000Z",
  }));
  const syncCredential = vi.fn(async (input: { targetUserId: string }) => ({
    result: "synced" as const,
    userId: input.targetUserId,
    revokedSessionCount: 1,
  }));
  const markSynced = vi.fn<(sourceId: string) => void>();
  const auth = {
    issueImportApproval,
    syncCredential,
    revokeImportApproval: vi.fn(async () => ({ revoked: true as const })),
  } as unknown as AuthCapability;
  return {
    input: {
      auth,
      actor: actor(),
      plan: plan(),
      report: report(),
      loaded: loaded(),
      cutoverEpochId: "cutover-1",
      syncedSourceIds,
      markSynced,
      renewLease: vi.fn(),
    },
    issueImportApproval,
    syncCredential,
    markSynced,
  };
}

function actor(): MigrationActor {
  return {
    scope: {
      tenantId: "tenant",
      botId: "bot",
      deploymentId: "deployment",
      userId: "operator",
      conversationId: "migration",
    } as never,
    operator: { userId: "operator", sessionId: "session", requestId: "request" },
  };
}

function plan(): MigrationPlan {
  const users = [plannedUser(record("admin-1", "admin"), "create"), plannedUser(record("user-1", "user"), "merge")];
  return {
    version: 1,
    sourceSystem: "dooragent",
    snapshotDigest: SNAPSHOT_DIGEST,
    inventoryDigest: "b".repeat(64),
    policy: { allowCredentialReuse: true, includeAssociatedData: false },
    policyDigest: "c".repeat(64),
    users,
    workspaces: [],
    planDigest: "d".repeat(64),
    planId: "plan-1",
    runId: "run-1",
  };
}

function plannedUser(source: DoorAgentUserRecord, decision: "create" | "merge"): MigrationPlan["users"][number] {
  return {
    source: { sourceSystem: "dooragent", sourceType: "user", sourceId: source.sourceId, sourceDigest: source.sourceDigest },
    decision,
    targetUserId: decision === "merge" ? "stale-planned-target" : null,
    credential: { action: "reuse", algorithm: "scrypt", profile: "dooragent-scrypt-v1" },
    candidateDigest: "e".repeat(64),
    credentialSync: null,
    reasonCode: null,
  };
}

function report(): MigrationReport {
  const source = plan().users;
  return {
    mode: "apply",
    status: "complete",
    runId: "run-1",
    planId: "plan-1",
    planDigest: "d".repeat(64),
    snapshotDigest: SNAPSHOT_DIGEST,
    counts: { total: 2, migrated: 1, merged: 1, rejected: 0, resetRequired: 0 },
    users: [
      { source: source[0]!.source, targetUserId: "created-target", result: "migrated", reasonCode: null },
      { source: source[1]!.source, targetUserId: "merged-target", result: "merged", reasonCode: null },
    ],
    workspaceCounts: { total: 0, migrated: 0, merged: 0, rejected: 0 },
    workspaces: [],
    reportDigest: "f".repeat(64),
  };
}

function loaded(): LoadedDoorAgentSource {
  const records = [record("admin-1", "admin"), record("user-1", "user")];
  return {
    inventory: {
      sourceSystem: "dooragent",
      snapshotDigest: SNAPSHOT_DIGEST,
      manifestVersion: 5,
      inventoryDigest: "b".repeat(64),
      counts: [{ sourceType: "user", count: 2 }],
      users: records.map(({ sourceId, sourceDigest, role, status }) => ({ sourceId, sourceDigest, role, status })),
    },
    records,
  };
}

function record(sourceId: string, role: "admin" | "user"): DoorAgentUserRecord {
  return {
    sourceId,
    sourceDigest: role === "admin" ? "1".repeat(64) : "2".repeat(64),
    email: `${sourceId}@example.invalid`,
    displayName: sourceId,
    role,
    status: "active",
    passwordEncoded: `scrypt:${"3".repeat(32)}:${"4".repeat(128)}`,
    workspaceRoot: `/archive/${sourceId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastLoginAt: null,
    userGroup: "default",
  };
}
