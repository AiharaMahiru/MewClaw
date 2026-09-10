import { scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  AuthCredentialRollbackStore,
  AuthOperator,
  AuthWriteContext,
} from "./capability.js";
import { credentialSyncCredentialDigest, prepareCredentialSync } from "./credential-sync.js";
import { hashOpaqueToken } from "./crypto.js";
import type {
  AuthApprovalBinding,
  PersistApprovalInput,
  PersistApprovalRevocationInput,
  PersistRollbackInput,
  PersistUserImportInput,
} from "./import-service.js";
import {
  PostgresAuthImportStore,
  type AuthImportMapping,
  type AuthImportPersistence,
  type AuthImportReader,
  type AuthImportTransaction,
  type BoundImportAction,
  type ImportAuditRecord,
  type PersistedAuthUser,
} from "./postgres-import-store.js";

const NOW = "2026-08-24T00:00:00.000Z";
const APPROVAL_REF = "approval-secret-that-must-not-be-persisted";
const SOURCE_DIGEST = "a".repeat(64);

describe("PostgresAuthImportStore", () => {
  it("uses the source triple as identity and digest as replay guard", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const first = await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));
    const replay = await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));

    expect(first).toMatchObject({ result: "migrated", mappingCreated: true });
    expect(replay).toMatchObject({ result: "migrated", mappingCreated: false });
    expect(persistence.state.users).toHaveLength(1);
    expect(persistence.state.mappings).toHaveLength(1);
    expect(persistence.state.audits).toHaveLength(1);

    await expect(store.applyUserImport(persistence.approve(importInput("b".repeat(64)))))
      .rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
    expect(persistence.state.users).toHaveLength(1);
    expect(persistence.state.mappings).toHaveLength(1);
  });

  it("rejects replaying a source mapping into another run", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const first = importInput("a".repeat(64));
    await store.applyUserImport(persistence.approve(first));
    const second = { ...first, runId: "run-2", planId: "plan-2" };

    await expect(store.applyUserImport(persistence.approve(second)))
      .rejects.toMatchObject({ code: "IMPORT_INPUT_INVALID" });
    expect(persistence.state.mappings).toHaveLength(1);
  });

  it("serializes concurrent replays by source and target email", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    const results = await Promise.all([
      store.applyUserImport(persistence.approve(importInput("a".repeat(64)))),
      store.applyUserImport(persistence.approve(importInput("a".repeat(64)))),
    ]);

    expect(results.map((result) => result.mappingCreated).sort()).toEqual([false, true]);
    expect(persistence.state.users).toHaveLength(1);
    expect(persistence.state.mappings).toHaveLength(1);
    expect(persistence.state.locks.some((key) => key.includes("\0source\0"))).toBe(true);
    expect(persistence.state.locks.some((key) => key.includes("\0email\0"))).toBe(true);
  });

  it("converges different sources with the same email without replacing credentials", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    const results = await Promise.all([
      store.applyUserImport(persistence.approve(importInput("a".repeat(64), "source-1"))),
      store.applyUserImport(persistence.approve(importInput("b".repeat(64), "source-2"))),
    ]);

    expect(results.map((result) => result.result).sort()).toEqual(["merged", "migrated"]);
    expect(persistence.state.users).toHaveLength(1);
    expect(persistence.state.passwords).toHaveLength(1);
    expect(persistence.state.mappings).toHaveLength(2);
  });

  it("persists the approved role instead of promoting the first user", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));

    expect(persistence.state.users[0]).toMatchObject({ role: "user", defaultMode: "lightweight" });
  });

  it("does not merge into a pending unverified target account", async () => {
    const persistence = new MemoryPersistence();
    persistence.state.users.push({
      id: "pending-user",
      email: "imported@example.com",
      displayName: "Pending User",
      role: "user",
      defaultMode: "lightweight",
      status: "pending",
      createdAt: NOW,
    });
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    const result = await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));

    expect(result).toMatchObject({
      result: "rejected",
      userId: "pending-user",
      reasonCode: "TARGET_USER_NOT_ACTIVE",
    });
    expect(persistence.state.passwords).toHaveLength(0);
  });

  it("preserves an existing active user's password when merging by email", async () => {
    const persistence = new MemoryPersistence();
    persistence.state.users.push({
      id: "existing-user",
      email: "imported@example.com",
      displayName: "Existing User",
      role: "user",
      defaultMode: "lightweight",
      status: "active",
      createdAt: NOW,
    });
    persistence.state.passwords.push({ userId: "existing-user", encoded: "existing-credential" });
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    const result = await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));

    expect(result).toMatchObject({ result: "merged", userId: "existing-user" });
    expect(persistence.state.passwords).toEqual([
      { userId: "existing-user", encoded: "existing-credential" },
    ]);
  });

  it("keeps created targets when the rollback delta guard is unavailable", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    await store.applyUserImport(persistence.approve(importInput("a".repeat(64))));

    const result = await store.rollbackImport(persistence.approve({
      ...writeContext("f".repeat(64)),
      source: {
        sourceSystem: "dooragent",
        sourceType: "manifest",
        sourceId: "manifest-1",
        sourceDigest: "f".repeat(64),
      },
      approval: approval("rollback-run"),
    } satisfies PersistRollbackInput));

    expect(result).toMatchObject({
      rolledBack: 0,
      retained: 1,
      rejected: 1,
      reasonCode: "ROLLBACK_GUARD_UNAVAILABLE",
    });
    expect(persistence.state.users).toHaveLength(1);
    expect(persistence.state.mappings[0]?.rolledBackAt).toBeNull();
  });

  it("rolls back the transaction when cancellation occurs before commit", async () => {
    const controller = new AbortController();
    const persistence = new MemoryPersistence();
    persistence.abortOnAudit = controller;
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    await expect(store.applyUserImport(persistence.approve({
      ...importInput("a".repeat(64)),
      signal: controller.signal,
    }))).rejects.toMatchObject({ code: "IMPORT_ABORTED" });
    expect(persistence.state.users).toHaveLength(0);
    expect(persistence.state.passwords).toHaveLength(0);
    expect(persistence.state.mappings).toHaveLength(0);
  });

  it("rolls back user, mapping and credential when mandatory audit fails", async () => {
    const persistence = new MemoryPersistence();
    persistence.failAudit = true;
    const store = new PostgresAuthImportStore(persistence, () => NOW);

    await expect(store.applyUserImport(persistence.approve(importInput("a".repeat(64)))))
      .rejects.toThrow("audit unavailable");
    expect(persistence.state.users).toHaveLength(0);
    expect(persistence.state.passwords).toHaveLength(0);
    expect(persistence.state.mappings).toHaveLength(0);
    expect(persistence.state.audits).toHaveLength(0);
  });

  it("consumes an approval once and restores it when the business transaction rolls back", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const approved = persistence.approve(importInput("a".repeat(64)));
    persistence.failAudit = true;

    await expect(store.applyUserImport(approved)).rejects.toThrow("audit unavailable");
    expect(persistence.state.approvals[0]?.consumedAt).toBeNull();

    persistence.failAudit = false;
    await expect(store.applyUserImport(approved)).resolves.toMatchObject({ result: "migrated" });
    expect(persistence.state.approvals[0]?.consumedAt).toBe(NOW);
    await expect(store.applyUserImport(approved))
      .rejects.toMatchObject({ code: "APPROVAL_INVALID" });
  });

  it("reports a mismatch when the mapped target no longer exists", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const input = importInput("a".repeat(64));
    await store.applyUserImport(persistence.approve(input));

    const reconcileInput = { ...input, scopeDigest: "c".repeat(64) };
    await expect(store.reconcileImport(reconcileInput)).resolves.toEqual({ matched: 1, missing: 0, mismatched: 0 });
    persistence.state.users = [];
    await expect(store.reconcileImport(reconcileInput)).resolves.toEqual({ matched: 0, missing: 0, mismatched: 1 });
  });

  it("reports missing when a manifest has no registered durable run", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const input = importInput("a".repeat(64));
    const manifest = {
      ...input,
      source: {
        sourceSystem: "dooragent",
        sourceType: "manifest" as const,
        sourceId: "manifest-1",
        sourceDigest: "f".repeat(64),
      },
    };
    await store.applyUserImport(persistence.approve(input));

    await expect(store.reconcileImport({ ...manifest, scopeDigest: "c".repeat(64) }))
      .resolves.toEqual({ matched: 0, missing: 1, mismatched: 0 });
  });

  it("issues and revokes a fully bound approval without persisting the raw token", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const issued = approvalIssueInput();

    await store.issueApproval(issued);

    expect(persistence.state.approvals[0]).toMatchObject({
      input: {
        approvalHash: hashOpaqueToken(APPROVAL_REF),
        operation: "apply-user",
        scopeDigest: "c".repeat(64),
        snapshotDigest: "e".repeat(64),
      },
      revokedAt: null,
    });
    await expect(store.revokeApproval(approvalRevocationInput(issued))).resolves.toBe(true);
    expect(persistence.state.approvals[0]?.revokedAt).toBe(NOW);
    expect(persistence.state.audits.map((audit) => audit.action)).toEqual([
      "auth.import.approval-issued",
      "auth.import.approval-revoked",
    ]);
    expect(JSON.stringify(persistence.state)).not.toContain(APPROVAL_REF);
  });

  it("rolls back approval issuance and revocation when mandatory audit fails", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const issued = approvalIssueInput();
    persistence.failAudit = true;

    await expect(store.issueApproval(issued)).rejects.toThrow("audit unavailable");
    expect(persistence.state.approvals).toHaveLength(0);

    persistence.failAudit = false;
    await store.issueApproval(issued);
    persistence.failAudit = true;
    await expect(store.revokeApproval(approvalRevocationInput(issued)))
      .rejects.toThrow("audit unavailable");
    expect(persistence.state.approvals[0]?.revokedAt).toBeNull();
    expect(persistence.state.audits).toHaveLength(1);
  });

  it("does not revoke an approval from another admin session or import context", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const issued = approvalIssueInput();
    await store.issueApproval(issued);
    const revocation = approvalRevocationInput(issued);

    await expect(store.revokeApproval({
      ...revocation,
      operator: { ...revocation.operator, sessionId: "other-session" },
    })).resolves.toBe(false);
    await expect(store.revokeApproval({ ...revocation, planId: "other-plan" })).resolves.toBe(false);
    expect(persistence.state.approvals[0]?.revokedAt).toBeNull();
  });

  it("syncs a mapped credential only after a rollback snapshot and revokes old sessions", async () => {
    const persistence = new MemoryPersistence();
    const store = new PostgresAuthImportStore(persistence, () => NOW);
    const original = importInput(SOURCE_DIGEST);
    await store.applyUserImport(persistence.approve(original));
    persistence.state.sessions = [
      { userId: "user-1", revokedAt: null },
      { userId: "user-1", revokedAt: NOW },
    ];
    const raw = dooragentCredential("correct horse battery staple");
    const source = {
      sourceSystem: "dooragent" as const,
      sourceType: "credential" as const,
      sourceId: "source-1",
      sourceDigest: SOURCE_DIGEST,
    };
    const base = {
      ...writeContext(SOURCE_DIGEST),
      source,
      targetUserId: "user-1",
      expectedRole: "user" as const,
      expectedDefaultMode: "lightweight" as const,
      expectedStatus: "active" as const,
      sourceCredential: raw,
      rollbackSnapshotRef: "vault:dsh/credential-sync/source-1",
      credentialDigest: credentialSyncCredentialDigest({
        source,
        snapshotDigest: "e".repeat(64),
        targetUserId: "user-1",
        expectedRole: "user",
        expectedDefaultMode: "lightweight",
        expectedStatus: "active",
        normalizedEncoded: normalizedDooragent(raw),
      }),
    };
    const prepared = prepareCredentialSync(base);
    const snapshots: Array<Parameters<AuthCredentialRollbackStore["save"]>[0]> = [];
    const rollbackStore: AuthCredentialRollbackStore = {
      async save(input) { snapshots.push(structuredClone(input)); },
      async load() { return snapshots[0] ? structuredClone(snapshots[0]) : undefined; },
    };
    const approved = persistence.approve({
      ...base,
      ...prepared,
      approval: {
        operation: "sync-credential",
        payloadDigest: prepared.payloadDigest,
        scopeDigest: "c".repeat(64),
        snapshotDigest: "e".repeat(64),
        cutoverEpochId: "cutover-1",
      },
      rollbackStore,
    });

    await expect(store.syncCredential(approved)).resolves.toEqual({
      result: "synced",
      userId: "user-1",
      revokedSessionCount: 1,
    });
    if (original.credential.action !== "reuse") throw new Error("expected reusable credential");
    expect(snapshots.map((snapshot) => snapshot.encoded)).toEqual([original.credential.normalizedEncoded]);
    expect(persistence.state.passwords.at(-1)?.encoded).toBe(prepared.normalizedEncoded);
    expect(persistence.state.sessions.filter((session) => session.revokedAt === null)).toHaveLength(0);
    await expect(store.syncCredential(approved)).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    const retry = persistence.approve({
      ...base,
      ...prepared,
      approval: approved.approval,
      rollbackStore,
    });
    await expect(store.syncCredential(retry)).resolves.toEqual({
      result: "synced",
      userId: "user-1",
      revokedSessionCount: 0,
    });
    expect(snapshots.map((snapshot) => snapshot.encoded)).toEqual([original.credential.normalizedEncoded]);

    snapshots.length = 0;
    const passwordWriteCount = persistence.state.passwords.length;
    const alreadyEqual = persistence.approve({
      ...base,
      ...prepared,
      approval: approved.approval,
      rollbackStore,
    });
    await expect(store.syncCredential(alreadyEqual)).resolves.toEqual({
      result: "synced",
      userId: "user-1",
      revokedSessionCount: 0,
    });
    expect(snapshots).toHaveLength(0);
    expect(persistence.state.passwords).toHaveLength(passwordWriteCount);

    const selfNoOp = persistence.approve({
      ...base,
      ...prepared,
      operator: { ...base.operator, userId: "user-1" },
      approval: approved.approval,
      rollbackStore,
    });
    await expect(store.syncCredential(selfNoOp)).resolves.toMatchObject({
      result: "synced",
      revokedSessionCount: 0,
    });

    persistence.state.passwords.push({
      userId: "user-1",
      encoded: original.credential.normalizedEncoded,
    });
    const selfChange = persistence.approve({
      ...base,
      ...prepared,
      operator: { ...base.operator, userId: "user-1" },
      approval: approved.approval,
      rollbackStore,
    });
    await expect(store.syncCredential(selfChange))
      .rejects.toMatchObject({ code: "CREDENTIAL_STATE_CONFLICT" });
    expect(snapshots).toHaveLength(0);
  });
});

interface StoredApproval {
  input: PersistApprovalInput;
  createdAt: string;
  revokedAt: string | null;
  consumedAt: string | null;
}

interface MemoryState {
  users: PersistedAuthUser[];
  passwords: Array<{ userId: string; encoded: string }>;
  mappings: AuthImportMapping[];
  audits: ImportAuditRecord[];
  approvals: StoredApproval[];
  approvalChecks: AuthApprovalBinding[];
  operators: AuthOperator[];
  locks: string[];
  sessions: Array<{ userId: string; revokedAt: string | null }>;
}

class MemoryPersistence implements AuthImportPersistence {
  state: MemoryState = {
    users: [],
    passwords: [],
    mappings: [],
    audits: [],
    approvals: [],
    approvalChecks: [],
    operators: [],
    locks: [],
    sessions: [],
  };
  failAudit = false;
  abortOnAudit?: AbortController;
  private approvalSequence = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  approve<T extends AuthWriteContext & { approval: AuthApprovalBinding }>(input: T): T {
    const approvalRef = `approval-${++this.approvalSequence}`;
    const approved = { ...input, approvalRef };
    this.state.approvals.push({
      input: approvalInputFromWrite(approved),
      createdAt: NOW,
      revokedAt: null,
      consumedAt: null,
    });
    return approved;
  }

  async read<T>(run: (reader: AuthImportReader) => Promise<T>): Promise<T> {
    return run(new MemoryTransaction(this.state, this.failAudit));
  }

  async transaction<T>(run: (transaction: AuthImportTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const predecessor = this.transactionTail;
    let release: (() => void) | undefined;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await predecessor;
    try {
      const draft = structuredClone(this.state);
      const result = await run(new MemoryTransaction(draft, this.failAudit, this.abortOnAudit));
      if (signal?.aborted) throw Object.assign(new Error("IMPORT_ABORTED"), { code: "IMPORT_ABORTED" });
      this.state = draft;
      return result;
    } finally {
      release?.();
    }
  }

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}
}

class MemoryTransaction implements AuthImportTransaction {
  constructor(
    private readonly state: MemoryState,
    private readonly failAudit: boolean,
    private readonly abortOnAudit?: AbortController,
  ) {}

  async assertOperator(operator: AuthOperator): Promise<void> {
    this.state.operators.push(operator);
  }
  async consumeApproval(input: AuthWriteContext, approval: AuthApprovalBinding, now: string): Promise<void> {
    this.state.approvalChecks.push(approval);
    const stored = this.state.approvals.find((candidate) => writeApprovalMatches(candidate, input, approval, now));
    if (!stored) throw Object.assign(new Error("APPROVAL_INVALID"), { code: "APPROVAL_INVALID" });
    stored.consumedAt = now;
  }
  async insertApproval(input: PersistApprovalInput, now: string): Promise<void> {
    if (this.state.approvals.some((approval) => approval.input.approvalHash === input.approvalHash)) {
      throw Object.assign(new Error("APPROVAL_INVALID"), { code: "APPROVAL_INVALID" });
    }
    this.state.approvals.push({ input, createdAt: now, revokedAt: null, consumedAt: null });
  }
  async revokeApproval(input: PersistApprovalRevocationInput, now: string): Promise<boolean> {
    const approval = this.state.approvals.find((candidate) => activeApprovalMatches(candidate, input, now));
    if (!approval) return false;
    approval.revokedAt = now;
    return true;
  }
  async lockImportKey(key: string): Promise<void> { this.state.locks.push(key); }
  async findMapping(source: AuthWriteContext["source"]): Promise<AuthImportMapping | undefined> {
    return this.state.mappings.find((item) => mappingKey(item) === mappingKey(source));
  }
  async findUserByEmail(email: string): Promise<PersistedAuthUser | undefined> {
    return this.state.users.find((user) => user.email === email);
  }
  async findUserById(userId: string): Promise<PersistedAuthUser | undefined> {
    return this.state.users.find((user) => user.id === userId);
  }
  async lockUserById(userId: string): Promise<PersistedAuthUser | undefined> {
    return this.state.users.find((user) => user.id === userId);
  }
  async createUser(candidate: PersistUserImportInput["candidate"], now: string): Promise<PersistedAuthUser> {
    const user = { id: `user-${this.state.users.length + 1}`, ...candidate, createdAt: now };
    this.state.users.push(user);
    return user;
  }
  async setPassword(userId: string, encoded: string): Promise<void> {
    this.state.passwords.push({ userId, encoded });
  }
  async getPassword(userId: string): Promise<{ encoded: string } | undefined> {
    const rows = this.state.passwords.filter((password) => password.userId === userId);
    const current = rows.at(-1);
    return current ? { encoded: current.encoded } : undefined;
  }
  async revokeUserSessions(userId: string, now: string): Promise<number> {
    let count = 0;
    for (const session of this.state.sessions) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }
  async findResource(): Promise<undefined> { return undefined; }
  async createResource(): Promise<boolean> { return true; }
  async insertMapping(mapping: AuthImportMapping): Promise<void> { this.state.mappings.push(mapping); }
  async listMappings(): Promise<AuthImportMapping[]> { return [...this.state.mappings]; }
  async listRunActions(): Promise<undefined> { return undefined; }
  async insertRunActions(): Promise<void> {}
  async findImportRun(): Promise<"missing"> { return "missing"; }
  async listLeaseableActions(): Promise<[]> { return []; }
  async leaseImportAction(): Promise<void> {}
  async bindImportAction(): Promise<BoundImportAction> {
    return { runId: "run-1", actionId: "f".repeat(64), sequence: 1 };
  }
  async completeImportAction(): Promise<void> {}
  async listLeaseableOutbox(): Promise<[]> { return []; }
  async listOutboxReceipts(): Promise<[]> { return []; }
  async leaseOutboxEvent(): Promise<void> {}
  async ackOutboxEvent(): Promise<boolean> { return false; }
  async deleteUser(userId: string): Promise<void> {
    this.state.users = this.state.users.filter((user) => user.id !== userId);
  }
  async deleteResource(): Promise<void> {}
  async markMappingRolledBack(): Promise<void> {}
  async writeAudit(record: ImportAuditRecord): Promise<void> {
    if (this.failAudit) throw new Error("audit unavailable");
    this.abortOnAudit?.abort();
    this.state.audits.push(record);
  }
}

function importInput(sourceDigest: string, sourceId = "source-1"): PersistUserImportInput {
  return {
    ...writeContext(sourceDigest),
    candidate: {
      email: "imported@example.com",
      displayName: "Imported User",
      role: "user",
      defaultMode: "lightweight",
      status: "active",
    },
    credential: {
      action: "reuse",
      algorithm: "scrypt",
      profile: "dsh-native",
      normalizedEncoded: `scrypt$16384$8$1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(32).toString("base64url")}`,
    },
    approval: approval("apply-user"),
    actionLease: {
      actionId: "f".repeat(64),
      leaseToken: "lease-token",
      payloadDigest: "a".repeat(64),
    },
    source: { ...writeContext(sourceDigest).source, sourceId },
  };
}

function writeContext(sourceDigest: string): AuthWriteContext {
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
    snapshotDigest: "e".repeat(64),
    source: { sourceSystem: "dooragent", sourceType: "user", sourceId: "source-1", sourceDigest },
    approvalRef: "approval",
    cutoverEpochId: "cutover-1",
  };
}

function approval(operation: AuthApprovalBinding["operation"]): AuthApprovalBinding {
  return {
    operation,
    payloadDigest: "b".repeat(64),
    scopeDigest: "c".repeat(64),
    snapshotDigest: "e".repeat(64),
    cutoverEpochId: "cutover-1",
  };
}

function approvalIssueInput(): PersistApprovalInput {
  const context = writeContext("a".repeat(64));
  return {
    scope: context.scope,
    operator: context.operator,
    runId: context.runId,
    planId: context.planId,
    snapshotDigest: context.snapshotDigest,
    source: context.source,
    operation: "apply-user",
    payloadDigest: "b".repeat(64),
    cutoverEpochId: context.cutoverEpochId,
    approvalHash: hashOpaqueToken(APPROVAL_REF),
    scopeDigest: "c".repeat(64),
    expiresAt: "2026-08-24T00:01:00.000Z",
  };
}

function approvalRevocationInput(input: PersistApprovalInput): PersistApprovalRevocationInput {
  return {
    scope: input.scope,
    operator: { ...input.operator, requestId: "revoke-request" },
    runId: input.runId,
    planId: input.planId,
    snapshotDigest: input.snapshotDigest,
    source: input.source,
    approvalHash: input.approvalHash,
    scopeDigest: input.scopeDigest,
  };
}

function activeApprovalMatches(
  stored: StoredApproval,
  input: PersistApprovalRevocationInput,
  now: string,
): boolean {
  const issued = stored.input;
  return stored.revokedAt === null
    && stored.consumedAt === null
    && Date.parse(issued.expiresAt) > Date.parse(now)
    && issued.approvalHash === input.approvalHash
    && issued.operator.userId === input.operator.userId
    && issued.operator.sessionId === input.operator.sessionId
    && issued.runId === input.runId
    && issued.planId === input.planId
    && issued.scopeDigest === input.scopeDigest
    && issued.snapshotDigest === input.snapshotDigest
    && mappingKey(issued.source) === mappingKey(input.source)
    && issued.source.sourceDigest === input.source.sourceDigest;
}

function writeApprovalMatches(
  stored: StoredApproval,
  input: AuthWriteContext,
  approval: AuthApprovalBinding,
  now: string,
): boolean {
  const issued = stored.input;
  return stored.revokedAt === null
    && stored.consumedAt === null
    && Date.parse(issued.expiresAt) > Date.parse(now)
    && issued.approvalHash === hashOpaqueToken(input.approvalRef)
    && issued.operator.userId === input.operator.userId
    && issued.operator.sessionId === input.operator.sessionId
    && issued.runId === input.runId
    && issued.planId === input.planId
    && issued.scopeDigest === approval.scopeDigest
    && issued.operation === approval.operation
    && issued.payloadDigest === approval.payloadDigest
    && issued.snapshotDigest === approval.snapshotDigest
    && issued.cutoverEpochId === approval.cutoverEpochId
    && mappingKey(issued.source) === mappingKey(input.source)
    && issued.source.sourceDigest === input.source.sourceDigest;
}

function approvalInputFromWrite(
  input: AuthWriteContext & { approval: AuthApprovalBinding },
): PersistApprovalInput {
  return {
    scope: input.scope,
    operator: input.operator,
    runId: input.runId,
    planId: input.planId,
    snapshotDigest: input.snapshotDigest,
    source: input.source,
    operation: input.approval.operation,
    payloadDigest: input.approval.payloadDigest,
    cutoverEpochId: input.cutoverEpochId,
    approvalHash: hashOpaqueToken(input.approvalRef),
    scopeDigest: input.approval.scopeDigest,
    expiresAt: "2026-08-24T00:01:00.000Z",
  };
}

function mappingKey(source: { sourceSystem: string; sourceType: string; sourceId: string }): string {
  return `${source.sourceSystem}\0${source.sourceType}\0${source.sourceId}`;
}

function dooragentCredential(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

function normalizedDooragent(encoded: string): string {
  const parts = encoded.split(":");
  return ["scrypt", "16384", "8", "1", Buffer.from(parts[1]!, "ascii").toString("base64url"), Buffer.from(parts[2]!, "hex").toString("base64url")].join("$");
}
