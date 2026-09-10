import type {
  AuthCapability,
  AuthImportOutboxLease,
  AuthImportOutboxReceipt,
} from "dsh-lark-auth";
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
import { buildUserActionManifest, executeUserActionRun } from "./user-action-runner.js";
import type {
  DoorAgentUserRecord,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationPlan,
} from "./types.js";
import type { WorkspaceMigrationProvider } from "./workspace-provider.js";

describe("buildUserActionManifest", () => {
  it("关联数据阶段跳过已有用户的重复 apply-user action", () => {
    const plan = makePlan(true);

    const actions = buildUserActionManifest(plan);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ operation: "claim-resource", sequence: 1 });
  });

  it("普通用户迁移阶段仍为 merge 用户登记 action", () => {
    const plan = makePlan(false);

    expect(buildUserActionManifest(plan).map((action) => action.operation)).toEqual([
      "apply-user", "claim-resource",
    ]);
  });
});

describe("executeUserActionRun", () => {
  it("把新建用户的真实 ID 传给工作区 provider", async () => {
    const plan = makeCreatePlan();
    const actions = buildUserActionManifest(plan);
    const mock = createExecutionAuth(actions);
    const provider = createWorkspaceProvider();

    const result = await executeUserActionRun(input(plan, mock.auth, provider));

    expect(provider.migrate).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: "actual-user" }));
    expect(mock.claimResource).toHaveBeenCalledWith(expect.objectContaining({
      actionLease: expect.objectContaining({ payloadDigest: actions[1]!.payloadDigest }),
    }));
    expect(result.users[0]).toMatchObject({ result: "migrated", targetUserId: "actual-user" });
    expect(result.workspaces[0]).toMatchObject({
      result: "migrated",
      targetUserId: "actual-user",
      targetWorkspaceId: "workspace-1",
    });
  });

  it("从已完成用户 outbox 恢复真实 ID 后继续工作区动作", async () => {
    const plan = makeCreatePlan();
    const actions = buildUserActionManifest(plan);
    const userEvent = userOutbox(actions[0]!);
    const mock = createExecutionAuth(actions, [actions[1]!], [userEvent]);
    const provider = createWorkspaceProvider();

    const result = await executeUserActionRun(input(plan, mock.auth, provider));

    expect(mock.applyUserImport).not.toHaveBeenCalled();
    expect(provider.migrate).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: "actual-user" }));
    expect(result.workspaces[0]?.targetWorkspaceId).toBe("workspace-1");
  });

  it("用资源 outbox 中的 workspace ID 恢复已完成工作区而不重复复制", async () => {
    const plan = makeCreatePlan();
    const actions = buildUserActionManifest(plan);
    const events = [userOutbox(actions[0]!), workspaceOutbox(actions[1]!)];
    const mock = createExecutionAuth(actions, [], events);
    const provider = createWorkspaceProvider();

    const result = await executeUserActionRun(input(plan, mock.auth, provider));

    expect(mock.applyUserImport).not.toHaveBeenCalled();
    expect(provider.migrate).not.toHaveBeenCalled();
    expect(result.workspaces[0]).toMatchObject({ targetWorkspaceId: "workspace-1", targetUserId: "actual-user" });
  });

  it("对复用凭证的 merge 用户签发独立 approval 并调用 syncCredential", async () => {
    const plan = makeCredentialSyncPlan();
    const actions = buildUserActionManifest(plan);
    const mock = createExecutionAuth(actions, actions, [], "target-user");

    await executeUserActionRun(input(plan, mock.auth, createWorkspaceProvider()));

    expect(mock.issueImportApproval).toHaveBeenCalledWith(expect.objectContaining({
      operation: "sync-credential",
      cutoverEpochId: "cutover-epoch",
      source: {
        sourceSystem: "dooragent",
        sourceType: "credential",
        sourceId: "user-1",
        sourceDigest: "a".repeat(64),
      },
      targetUserId: "target-user",
      expectedRole: "user",
      expectedDefaultMode: "lightweight",
      expectedStatus: "active",
      credentialDigest: "9".repeat(64),
      rollbackSnapshotRef: "vault:dsh/dooragent/credential-sync/source-user-1",
    }));
    expect(mock.syncCredential).toHaveBeenCalledWith(expect.objectContaining({
      approvalRef: "item-approval",
      cutoverEpochId: "cutover-epoch",
      targetUserId: "target-user",
      sourceCredential: makeLoaded().records[0]!.passwordEncoded,
      credentialDigest: "9".repeat(64),
      rollbackSnapshotRef: "vault:dsh/dooragent/credential-sync/source-user-1",
    }));
  });

  it("恢复已完成 user outbox 时会补做缺失的 credential sync", async () => {
    const plan = makeCredentialSyncPlan();
    const actions = buildUserActionManifest(plan);
    const mock = createExecutionAuth(actions, [], [userOutbox(actions[0]!, "target-user")], "target-user");

    await executeUserActionRun(input(plan, mock.auth, createWorkspaceProvider()));

    expect(mock.applyUserImport).not.toHaveBeenCalled();
    expect(mock.syncCredential).toHaveBeenCalledTimes(1);
  });
});

function input(
  plan: MigrationPlan,
  auth: AuthCapability,
  workspaceProvider: WorkspaceMigrationProvider,
) {
  return {
    auth,
    actor: ACTOR,
    plan,
    loaded: makeLoaded(),
    approval: { approvalRef: "run-approval", cutoverEpochId: "cutover-epoch" },
    workspaceProvider,
    options: {
      batchSize: 10,
      leaseMs: 60_000,
      renewLease: vi.fn(),
      markCredentialSynced: vi.fn(),
      saveUserResultReceipt: vi.fn(),
      saveObjectResultReceipt: vi.fn(),
      deliverUserResult: vi.fn(async () => undefined),
    },
  };
}

function createExecutionAuth(
  actions: ReturnType<typeof buildUserActionManifest>,
  pendingActions = actions,
  completed: AuthImportOutboxLease[] = [],
  appliedUserId = "actual-user",
) {
  const outbox = [...completed];
  const issueImportApproval = vi.fn(async () => ({ approvalRef: "item-approval", expiresAt: "2026-08-24T07:00:00.000Z" }));
  const applyUserImport = vi.fn(async (input: Parameters<AuthCapability["applyUserImport"]>[0]) => {
    const action = actions.find((item) => item.actionId === input.actionLease.actionId)!;
    const result = { result: "migrated" as const, userId: appliedUserId, mappingCreated: true };
    outbox.push(userOutbox(action, appliedUserId));
    return result;
  });
  const syncCredential = vi.fn(async (input: Parameters<AuthCapability["syncCredential"]>[0]) => ({
    result: "synced" as const,
    userId: input.targetUserId,
    revokedSessionCount: 2,
  }));
  const claimResource = vi.fn(async (input: Parameters<AuthCapability["claimResource"]>[0]) => {
    const action = actions.find((item) => item.actionId === input.actionLease.actionId)!;
    outbox.push(workspaceOutbox(action));
    return { result: "claimed" as const, userId: input.targetUserId };
  });
  const leaseImportActions = vi.fn(async () => pendingActions.map((action) => ({
    ...action,
    leaseToken: `action-${action.sequence}`,
    leaseExpiresAt: "2026-08-24T07:00:00.000Z",
  })));
  const leaseImportOutbox = vi.fn(async () => outbox.map((event) => ({
    ...event,
    leaseToken: `outbox-${event.sequence}`,
    leaseExpiresAt: "2026-08-24T07:00:00.000Z",
  })));
  const listImportOutboxReceipts = vi.fn(async (
    request: Parameters<AuthCapability["listImportOutboxReceipts"]>[0],
  ) => outbox.filter((event) => event.sequence > request.afterSequence).map(toReceipt));
  const auth = {
    applyUserImport,
    claimResource,
    syncCredential,
    leaseImportActions,
    leaseImportOutbox,
    listImportOutboxReceipts,
    issueImportApproval,
    revokeImportApproval: vi.fn(async () => ({ revoked: true as const })),
  } as unknown as AuthCapability;
  return { auth, applyUserImport, claimResource, issueImportApproval, syncCredential };
}

function createWorkspaceProvider(): WorkspaceMigrationProvider {
  return {
    migrate: vi.fn(async () => ({ result: "migrated" as const, workspaceId: "workspace-1", path: "D:/dsh/actual-user" })),
    rollback: vi.fn(async () => ({ result: "rolled-back" as const, reasonCode: null })),
  };
}

function userOutbox(
  action: ReturnType<typeof buildUserActionManifest>[number],
  targetUserId = "actual-user",
): AuthImportOutboxLease {
  return {
    eventId: `event-${action.sequence}`,
    actionId: action.actionId,
    sequence: action.sequence,
    result: { operation: "apply-user", result: "migrated", targetUserId, reasonCode: null },
    occurredAt: `2026-08-24T07:00:0${action.sequence}.000Z`,
    leaseToken: `outbox-${action.sequence}`,
    leaseExpiresAt: "2026-08-24T07:00:00.000Z",
  };
}

function workspaceOutbox(action: ReturnType<typeof buildUserActionManifest>[number]): AuthImportOutboxLease {
  return {
    eventId: `event-${action.sequence}`,
    actionId: action.actionId,
    sequence: action.sequence,
    result: {
      operation: "claim-resource",
      result: "claimed",
      targetUserId: "actual-user",
      targetResourceId: "workspace-1",
      reasonCode: null,
    },
    occurredAt: `2026-08-24T07:00:0${action.sequence}.000Z`,
    leaseToken: `outbox-${action.sequence}`,
    leaseExpiresAt: "2026-08-24T07:00:00.000Z",
  };
}

function toReceipt(event: AuthImportOutboxLease): AuthImportOutboxReceipt {
  return {
    eventId: event.eventId,
    actionId: event.actionId,
    sequence: event.sequence,
    result: event.result,
    occurredAt: event.occurredAt,
    acknowledgedAt: null,
  };
}

const SCOPE: Scope = {
  tenantId: makeTenantId("tenant"),
  botId: makeBotId("bot"),
  deploymentId: makeDeploymentId("migration"),
  userId: makeUserId("admin"),
  conversationId: makeConversationId("cutover"),
};
const ACTOR: MigrationActor = {
  scope: SCOPE,
  operator: { userId: SCOPE.userId, sessionId: "admin-session", requestId: "request-1" },
};

function makeCreatePlan(): MigrationPlan {
  const userSource = { sourceSystem: "dooragent" as const, sourceType: "user" as const, sourceId: "user-1", sourceDigest: "a".repeat(64) };
  const workspaceSource = { sourceSystem: "dooragent" as const, sourceType: "workspace" as const, sourceId: "user-1", sourceDigest: "b".repeat(64) };
  return {
    version: 1,
    sourceSystem: "dooragent",
    snapshotDigest: "c".repeat(64),
    inventoryDigest: "d".repeat(64),
    policy: { allowCredentialReuse: false, includeAssociatedData: true },
    policyDigest: "e".repeat(64),
    users: [{
      source: userSource,
      decision: "create",
      targetUserId: null,
      credential: { action: "reset_required", reason: "CREDENTIAL_UNSUPPORTED" },
      credentialSync: null,
      candidateDigest: "f".repeat(64),
      reasonCode: null,
    }],
    workspaces: [{
      source: workspaceSource,
      decision: "migrate",
      targetUserId: null,
      aggregate: {
        bytes: 0,
        directoryCount: 1,
        fileCount: 0,
        merkleRootSha256: "1".repeat(64),
        specialFileCount: 0,
        symlinkCount: 0,
        unreadableEntries: 0,
        unstableFiles: 0,
      },
      candidateDigest: "2".repeat(64),
      reasonCode: null,
    }],
    planDigest: "3".repeat(64),
    planId: "4".repeat(64),
    runId: "5".repeat(64),
  };
}

function makeLoaded(): LoadedDoorAgentSource {
  const record: DoorAgentUserRecord = {
    sourceId: "user-1",
    sourceDigest: "a".repeat(64),
    email: "user@example.invalid",
    displayName: "User",
    role: "user",
    status: "active",
    passwordEncoded: "",
    workspaceRoot: "D:/source/user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lastLoginAt: null,
    userGroup: "default",
  };
  const workspace = {
    sourceUserId: "user-1",
    rootPathSha256: "6".repeat(64),
    sourceDigest: "b".repeat(64),
    status: "manifested" as const,
    aggregate: {
      bytes: 0,
      directoryCount: 1,
      fileCount: 0,
      merkleRootSha256: "1".repeat(64),
      specialFileCount: 0,
      symlinkCount: 0,
      unreadableEntries: 0,
      unstableFiles: 0,
    },
    workspaceRoot: "D:/source/user-1",
  };
  const users = [{ sourceId: record.sourceId, sourceDigest: record.sourceDigest, role: record.role, status: record.status }];
  const content = {
    sourceSystem: "dooragent" as const,
    snapshotDigest: "c".repeat(64),
    manifestVersion: 4,
    counts: [{ sourceType: "user" as const, count: 1 }],
    users,
  };
  return { inventory: { ...content, inventoryDigest: digestCanonical(content) }, records: [record], workspaces: [workspace] };
}

function makePlan(includeAssociatedData: boolean): MigrationPlan {
  const userSource = {
    sourceSystem: "dooragent" as const,
    sourceType: "user" as const,
    sourceId: "user-1",
    sourceDigest: "a".repeat(64),
  };
  const workspaceSource = {
    sourceSystem: "dooragent" as const,
    sourceType: "workspace" as const,
    sourceId: "user-1",
    sourceDigest: "b".repeat(64),
  };
  return {
    version: 1,
    sourceSystem: "dooragent",
    snapshotDigest: "c".repeat(64),
    inventoryDigest: "d".repeat(64),
    policy: { allowCredentialReuse: false, includeAssociatedData },
    policyDigest: "e".repeat(64),
    users: [{
      source: userSource,
      decision: "merge",
      targetUserId: "target-user",
      credential: { action: "reset_required", reason: "CREDENTIAL_UNSUPPORTED" },
      candidateDigest: "f".repeat(64),
      credentialSync: null,
      reasonCode: null,
    }],
    workspaces: [{
      source: workspaceSource,
      decision: "migrate",
      targetUserId: "target-user",
      aggregate: null,
      candidateDigest: "1".repeat(64),
      reasonCode: null,
    }],
    planDigest: "2".repeat(64),
    planId: "3".repeat(64),
    runId: "4".repeat(64),
  };
}

function makeCredentialSyncPlan(): MigrationPlan {
  const plan = makePlan(false);
  plan.workspaces = [];
  plan.users[0]!.credential = { action: "reuse", algorithm: "scrypt", profile: "dooragent-scrypt-v1" };
  plan.users[0]!.credentialSync = {
    source: {
      sourceSystem: "dooragent",
      sourceType: "credential",
      sourceId: "user-1",
      sourceDigest: "a".repeat(64),
    },
    targetUserId: "target-user",
    expectedRole: "user",
    expectedDefaultMode: "lightweight",
    expectedStatus: "active",
    credentialDigest: "9".repeat(64),
    rollbackSnapshotRef: "vault:dsh/dooragent/credential-sync/source-user-1",
  };
  return plan;
}
