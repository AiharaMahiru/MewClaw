import { describe, expect, it } from "vitest";

import type {
  AuthImportApprovalIssueInput,
  AuthImportApprovalRevokeInput,
  AuthImportContext,
  AuthImportReconciliation,
  AuthImportRollbackResult,
  AuthResourceClaimResult,
  AuthUserImportResult,
} from "./capability.js";
import { hashOpaqueToken } from "./crypto.js";
import {
  DefaultAuthCapability,
  type AuthImportStore,
  type PersistApprovalInput,
  type PersistApprovalRevocationInput,
} from "./import-service.js";

const NOW = "2026-08-24T00:00:00.000Z";
const APPROVAL_REF = "approval-secret-that-is-returned-once";
const DIGEST = "a".repeat(64);

describe("Auth import approval management", () => {
  it("issues an opaque approval bound to the complete import context", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);

    const result = await capability.issueImportApproval(userApprovalInput());

    expect(result).toEqual({
      approvalRef: APPROVAL_REF,
      expiresAt: "2026-08-24T00:01:00.000Z",
    });
    expect(fixture.issued).toMatchObject({
      approvalHash: hashOpaqueToken(APPROVAL_REF),
      operation: "apply-user",
      payloadDigest: "b".repeat(64),
      snapshotDigest: DIGEST,
      cutoverEpochId: "cutover-1",
      expiresAt: "2026-08-24T00:01:00.000Z",
    });
    expect(fixture.issued?.scopeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.issued).not.toHaveProperty("approvalRef");
  });

  it("derives the run approval digest inside Auth and binds it to a manifest", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);

    await capability.issueImportApproval(runApprovalInput());

    expect(fixture.issued).toMatchObject({
      operation: "apply-run",
      source: { sourceType: "manifest", sourceId: "manifest-1" },
    });
    const firstDigest = fixture.issued?.payloadDigest;
    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(firstDigest).not.toBe("d".repeat(64));

    const reordered = runApprovalInput();
    const action = reordered.actions[0]!;
    reordered.actions = [{
      payloadDigest: action.payloadDigest,
      source: {
        sourceDigest: action.source.sourceDigest,
        sourceId: action.source.sourceId,
        sourceType: action.source.sourceType,
        sourceSystem: action.source.sourceSystem,
      },
      sequence: action.sequence,
      operation: action.operation,
      actionId: action.actionId,
    }];
    await capability.issueImportApproval(reordered);
    expect(fixture.issued?.payloadDigest).toBe(firstDigest);

    const changed = runApprovalInput();
    changed.actions = [{ ...changed.actions[0]!, payloadDigest: "e".repeat(64) }];
    await capability.issueImportApproval(changed);
    expect(fixture.issued?.payloadDigest).not.toBe(firstDigest);
  });

  it("rejects unknown fields in a run action manifest", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);
    const input = runApprovalInput();
    input.actions = [{ ...input.actions[0]!, credential: "must-not-enter-digest" }] as never;

    await expect(capability.issueImportApproval(input))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("rejects a rollback approval unless the source is a manifest", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);

    await expect(capability.issueImportApproval({
      ...userApprovalInput(),
      operation: "rollback-run",
    } as AuthImportApprovalIssueInput))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("rejects malformed approval bindings before persistence", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);
    const input = userApprovalInput();
    input.candidateDigest = "not-a-digest";

    await expect(capability.issueImportApproval(input))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("rejects an unknown operation at the runtime boundary", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);
    const input = userApprovalInput();
    input.operation = "delete-user" as never;

    await expect(capability.issueImportApproval(input))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(fixture.writes).toBe(0);
  });

  it("revokes by token hash without exposing the raw approval to persistence", async () => {
    const fixture = makeStore();
    const capability = makeCapability(fixture.store);

    await expect(capability.revokeImportApproval(revocationInput()))
      .resolves.toEqual({ revoked: true });

    expect(fixture.revoked).toMatchObject({
      approvalHash: hashOpaqueToken(APPROVAL_REF),
      snapshotDigest: DIGEST,
    });
    expect(fixture.revoked).not.toHaveProperty("approvalRef");
  });

  it("returns a generic approval error when revocation matches no active approval", async () => {
    const fixture = makeStore();
    fixture.revokeResult = false;
    const capability = makeCapability(fixture.store);

    await expect(capability.revokeImportApproval(revocationInput()))
      .rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });
});

function makeCapability(store: AuthImportStore): DefaultAuthCapability {
  return new DefaultAuthCapability(store, {
    approvalTtlMs: 60_000,
    createApprovalRef: () => APPROVAL_REF,
    now: () => NOW,
  });
}

function makeStore(): {
  store: AuthImportStore;
  writes: number;
  issued?: PersistApprovalInput;
  revoked?: PersistApprovalRevocationInput;
  revokeResult: boolean;
} {
  const fixture = {
    store: undefined as never,
    writes: 0,
    revokeResult: true,
  } as {
    store: AuthImportStore;
    writes: number;
    issued?: PersistApprovalInput;
    revoked?: PersistApprovalRevocationInput;
    revokeResult: boolean;
  };
  fixture.store = {
    async assertOperator() {},
    async issueApproval(input) {
      fixture.writes += 1;
      fixture.issued = input;
    },
    async revokeApproval(input) {
      fixture.writes += 1;
      fixture.revoked = input;
      return fixture.revokeResult;
    },
    async resolveUser() { return { kind: "missing" }; },
    async applyUserImport(): Promise<AuthUserImportResult> {
      return { result: "migrated", userId: "user-1", mappingCreated: true };
    },
    async claimResource(): Promise<AuthResourceClaimResult> {
      return { result: "claimed", userId: "user-1" };
    },
    async authorizeImportRun() { return { authorized: true as const }; },
    async reconcileImport(): Promise<AuthImportReconciliation> {
      return { matched: 0, missing: 1, mismatched: 0 };
    },
    async rollbackImport(): Promise<AuthImportRollbackResult> {
      return { rolledBack: 0, retained: 0, rejected: 0 };
    },
    async close() {},
  };
  return fixture;
}

function userApprovalInput(): Extract<AuthImportApprovalIssueInput, { operation: "apply-user" }> {
  return {
    ...readContext(),
    operation: "apply-user",
    candidateDigest: "b".repeat(64),
    cutoverEpochId: "cutover-1",
  };
}

function runApprovalInput(): Extract<AuthImportApprovalIssueInput, { operation: "apply-run" }> {
  return {
    ...manifestContext(),
    operation: "apply-run",
    planDigest: "d".repeat(64),
    actions: [{
      actionId: "c".repeat(64),
      operation: "apply-user",
      sequence: 1,
      source: { ...readContext().source, sourceSystem: "dooragent" },
      payloadDigest: "b".repeat(64),
    }],
    cutoverEpochId: "cutover-1",
  };
}

function revocationInput(): AuthImportApprovalRevokeInput {
  return { ...readContext(), approvalRef: APPROVAL_REF };
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
    snapshotDigest: DIGEST,
    source: {
      sourceSystem: "dooragent",
      sourceType: "user",
      sourceId: "source-user-1",
      sourceDigest: DIGEST,
    },
  };
}

function manifestContext(): AuthImportContext {
  return {
    ...readContext(),
    source: {
      sourceSystem: "dooragent",
      sourceType: "manifest",
      sourceId: "manifest-1",
      sourceDigest: DIGEST,
    },
  };
}
