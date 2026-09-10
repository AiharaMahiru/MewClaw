import { describe, expect, it } from "vitest";

import type {
  AuthImportContext,
  AuthImportReconciliation,
  AuthImportRollbackResult,
  AuthImportRunAuthorizeInput,
  AuthResourceClaimResult,
  AuthUserImportCandidate,
  AuthUserImportResult,
  AuthWriteContext,
} from "./capability.js";
import { hashPassword } from "./crypto.js";
import {
  DefaultAuthCapability,
  type AuthImportStore,
  type PersistResourceClaimInput,
  type PersistRollbackInput,
  type PersistRunAuthorizationInput,
  type PersistUserImportInput,
} from "./import-service.js";

const NOW = "2026-08-24T00:00:00.000Z";
const SOURCE_DIGEST = "a".repeat(64);
const ACTION_LEASE = {
  actionId: "f".repeat(64),
  leaseToken: "lease-token",
  payloadDigest: "d".repeat(64),
};

describe("DefaultAuthCapability", () => {
  it("keeps dry-run read-only", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const plan = await capability.dryRunUserImport({
      ...readContext(),
      candidate: candidate("user", "lightweight"),
    });

    expect(plan.decision).toBe("create");
    expect(fixture.reads).toBeGreaterThan(0);
    expect(fixture.writes).toBe(0);
  });

  it("passes an explicit user role without bootstrap promotion", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const passwordEncoded = await hashPassword("a sufficiently long password", () => Buffer.alloc(16, 3));
    const imported = { ...candidate("user", "lightweight"), passwordEncoded };
    const plan = await capability.dryRunUserImport({ ...readContext(), candidate: imported });

    await capability.applyUserImport({
      ...writeContext(),
      candidate: imported,
      actionLease: ACTION_LEASE,
    });

    expect(fixture.persisted?.candidate.role).toBe("user");
    expect(fixture.persisted?.candidate.defaultMode).toBe("lightweight");
    expect(fixture.persisted?.credential.action).toBe("reuse");
    expect(fixture.persisted?.approval).toMatchObject({
      operation: "apply-user",
      payloadDigest: plan.candidateDigest,
      snapshotDigest: SOURCE_DIGEST,
      cutoverEpochId: "cutover-1",
    });
    expect(fixture.persisted?.approval.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not expose normalized credential material from inspectCredential", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const encoded = await hashPassword("a sufficiently long password", () => Buffer.alloc(16, 4));

    const decision = await capability.inspectCredential({ sourceSystem: "dsh", encoded });

    expect(decision.action).toBe("reuse");
    expect(decision).not.toHaveProperty("normalizedEncoded");
  });

  it("rejects identity material until a dedicated import contract exists", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const unsafeCandidate = {
      ...candidate("user", "lightweight"),
      identities: [{ provider: "feishu", subject: "ou_sensitive" }],
    } as unknown as AuthUserImportCandidate;

    await expect(capability.applyUserImport({
      ...writeContext(),
      candidate: unsafeCandidate,
      actionLease: ACTION_LEASE,
    })).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("rejects a Scope that does not belong to the authenticated operator", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const input = writeContext();
    input.scope.userId = "other-user" as never;

    await expect(capability.applyUserImport({
      ...input,
      candidate: candidate("user", "lightweight"),
      actionLease: ACTION_LEASE,
    })).rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("rejects a missing durable action lease at the runtime boundary", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const input = {
      ...writeContext(),
      candidate: candidate("user", "lightweight"),
    } as unknown as Parameters<typeof capability.applyUserImport>[0];

    await expect(capability.applyUserImport(input))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("does not accept a per-user approval context for run rollback", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });

    await expect(capability.rollbackImport(writeContext()))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("binds a manifest rollback to a dedicated rollback operation", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const input = writeContext();
    input.source = { ...input.source, sourceType: "manifest", sourceId: "manifest-1" };

    await capability.rollbackImport(input);

    expect(fixture.rolledBack?.approval).toMatchObject({
      operation: "rollback-run",
      snapshotDigest: SOURCE_DIGEST,
      cutoverEpochId: "cutover-1",
    });
  });

  it("authorizes a complete run with approval bound to its plan and action manifest", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });

    await expect(capability.authorizeImportRun(runAuthorizationInput()))
      .resolves.toEqual({ authorized: true });

    expect(fixture.authorized?.approval).toMatchObject({
      operation: "apply-run",
      snapshotDigest: SOURCE_DIGEST,
      cutoverEpochId: "cutover-1",
    });
    expect(fixture.authorized?.approval.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.authorized?.approval.payloadDigest).not.toBe("d".repeat(64));
  });

  it("rejects run authorization for a non-manifest source", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });
    const input = runAuthorizationInput();
    input.source = { ...input.source, sourceType: "user" };

    await expect(capability.authorizeImportRun(input))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("binds resource ownership to a distinct approval payload", async () => {
    const fixture = makeStore();
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });

    await capability.claimResource({
      ...writeContext(),
      resourceType: "workspace",
      resourceId: "workspace-1",
      resourcePath: "D:/workspaces/user-1",
      targetUserId: "user-1",
      actionLease: ACTION_LEASE,
    });

    expect(fixture.claimed?.approval.operation).toBe("claim-resource");
    expect(fixture.claimed?.approval.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the committed result when cancellation happens after the store succeeds", async () => {
    const controller = new AbortController();
    const fixture = makeStore();
    fixture.store.applyUserImport = async () => {
      controller.abort();
      return { result: "migrated", userId: "user-1", mappingCreated: true };
    };
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });

    await expect(capability.applyUserImport({
      ...writeContext(),
      signal: controller.signal,
      candidate: candidate("user", "lightweight"),
      actionLease: ACTION_LEASE,
    })).resolves.toEqual({ result: "migrated", userId: "user-1", mappingCreated: true });
  });

  it("returns the only approval reference after the approval store commits", async () => {
    const controller = new AbortController();
    const fixture = makeStore();
    fixture.store.issueApproval = async () => {
      controller.abort();
      fixture.writes += 1;
    };
    const capability = new DefaultAuthCapability(fixture.store, {
      now: () => NOW,
      createApprovalRef: () => "issued-approval",
    });

    await expect(capability.issueImportApproval({
      ...readContext(),
      signal: controller.signal,
      operation: "apply-run",
      planDigest: "d".repeat(64),
      actions: [],
      cutoverEpochId: "cutover-1",
      source: {
        sourceSystem: "dooragent",
        sourceType: "manifest",
        sourceId: "manifest-1",
        sourceDigest: SOURCE_DIGEST,
      },
    })).resolves.toMatchObject({ approvalRef: "issued-approval" });
  });

  it("reports a committed approval revocation after cancellation", async () => {
    const controller = new AbortController();
    const fixture = makeStore();
    fixture.store.revokeApproval = async () => {
      controller.abort();
      fixture.writes += 1;
      return true;
    };
    const capability = new DefaultAuthCapability(fixture.store, { now: () => NOW });

    await expect(capability.revokeImportApproval({
      ...readContext(),
      signal: controller.signal,
      approvalRef: "approval",
    })).resolves.toEqual({ revoked: true });
  });
});

function makeStore(): {
  store: AuthImportStore;
  reads: number;
  writes: number;
  persisted?: PersistUserImportInput;
  claimed?: PersistResourceClaimInput;
  rolledBack?: PersistRollbackInput;
  authorized?: PersistRunAuthorizationInput;
} {
  const fixture: {
    store: AuthImportStore;
    reads: number;
    writes: number;
    persisted?: PersistUserImportInput;
    claimed?: PersistResourceClaimInput;
    rolledBack?: PersistRollbackInput;
    authorized?: PersistRunAuthorizationInput;
  } = { store: undefined as never, reads: 0, writes: 0 };
  fixture.store = {
    async assertOperator() { fixture.reads += 1; },
    async issueApproval() { fixture.writes += 1; },
    async revokeApproval() { fixture.writes += 1; return true; },
    async resolveUser() { fixture.reads += 1; return { kind: "missing" }; },
    async applyUserImport(input): Promise<AuthUserImportResult> {
      fixture.writes += 1;
      fixture.persisted = input;
      return { result: "migrated", userId: "user-1", mappingCreated: true };
    },
    async claimResource(input): Promise<AuthResourceClaimResult> {
      fixture.writes += 1;
      fixture.claimed = input;
      return { result: "claimed", userId: "user-1" };
    },
    async reconcileImport(): Promise<AuthImportReconciliation> {
      fixture.reads += 1;
      return { matched: 0, missing: 1, mismatched: 0 };
    },
    async rollbackImport(input): Promise<AuthImportRollbackResult> {
      fixture.writes += 1;
      fixture.rolledBack = input;
      return { rolledBack: 0, retained: 0, rejected: 0 };
    },
    async authorizeImportRun(input) {
      fixture.writes += 1;
      fixture.authorized = input;
      return { authorized: true as const };
    },
    async close() {},
  };
  return fixture;
}

function candidate(role: "admin" | "user", defaultMode: "full" | "lightweight") {
  return {
    email: "User@Example.com",
    displayName: "Imported User",
    role,
    defaultMode,
    status: "active" as const,
  };
}

function readContext(): AuthImportContext {
  return {
    scope: {
      tenantId: "tenant" as never,
      botId: "bot" as never,
      deploymentId: "deployment" as never,
      userId: "operator" as never,
      conversationId: "migration" as never,
    },
    operator: { userId: "operator", sessionId: "session", requestId: "request" },
    runId: "run-1",
    planId: "plan-1",
    snapshotDigest: SOURCE_DIGEST,
    source: {
      sourceSystem: "dsh",
      sourceType: "user",
      sourceId: "source-user-1",
      sourceDigest: SOURCE_DIGEST,
    },
  };
}

function writeContext(): AuthWriteContext {
  return { ...readContext(), approvalRef: "approval", cutoverEpochId: "cutover-1" };
}

function runAuthorizationInput(): AuthImportRunAuthorizeInput {
  return {
    ...writeContext(),
    planDigest: "d".repeat(64),
    actions: [],
    source: {
      sourceSystem: "dooragent",
      sourceType: "manifest",
      sourceId: "manifest-1",
      sourceDigest: SOURCE_DIGEST,
    },
  };
}
