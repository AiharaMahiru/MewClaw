import { createHash } from "node:crypto";

import {
  AuthImportError,
  type AuthImportActionDefinition,
  type AuthImportActionLease,
  type AuthImportActionLeaseBinding,
  type AuthImportActionResult,
  type AuthImportContext,
  type AuthCredentialSyncResult,
  type AuthImportOutboxLease,
  type AuthImportOutboxReceipt,
  type AuthImportReconciliation,
  type AuthImportRollbackResult,
  type AuthImportSource,
  type AuthOperator,
  type AuthResourceClaimResult,
  type AuthUserImportResult,
  type AuthUserResolution,
  type AuthWriteContext,
} from "./capability.js";
import type {
  AuthApprovalBinding,
  AuthImportStore,
  NormalizedAuthUserImportCandidate,
  PersistApprovalInput,
  PersistApprovalRevocationInput,
  PersistCredentialSyncInput,
  PersistImportLeaseInput,
  PersistImportOutboxReceiptInput,
  PersistImportOutboxAckInput,
  PersistReconcileInput,
  PersistResourceClaimInput,
  PersistRollbackInput,
  PersistRunAuthorizationInput,
  PersistUserImportInput,
} from "./import-service.js";
import { throwIfAborted } from "./import-service.js";
import { hashOpaqueToken } from "./crypto.js";
import {
  completeResourceAction,
  completeUserAction,
  leaseActions,
  leaseOutbox,
} from "./postgres-import-action-utils.js";
import type {
  AuthImportMapping,
  MappingResult,
  PersistedAuthUser,
  PersistedResource,
} from "./postgres-import-rows.js";

export interface ImportAuditRecord {
  action: string;
  userId: string | null;
  requestId: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface AuthImportReader {
  assertOperator(operator: AuthOperator, now: string): Promise<void>;
  findMapping(source: AuthImportSource): Promise<AuthImportMapping | undefined>;
  findUserByEmail(email: string): Promise<PersistedAuthUser | undefined>;
  findUserById(userId: string): Promise<PersistedAuthUser | undefined>;
  findResource(resourceType: "session" | "workspace", resourceId: string): Promise<PersistedResource | undefined>;
  listMappings(runId: string, planId: string, sourceSystem: string): Promise<AuthImportMapping[]>;
  listRunActions(input: PersistReconcileInput): Promise<AuthImportActionDefinition[] | undefined>;
  listOutboxReceipts(input: PersistImportOutboxReceiptInput): Promise<AuthImportOutboxReceipt[]>;
}

export interface BoundImportAction {
  runId: string;
  actionId: string;
  sequence: number;
}

export interface ImportOutboxRecord {
  eventId: string;
  actionId: string;
  sequence: number;
  result: AuthImportActionResult;
  occurredAt: string;
}

export interface AuthImportTransaction extends AuthImportReader {
  consumeApproval(input: AuthWriteContext, approval: AuthApprovalBinding, now: string): Promise<void>;
  insertApproval(input: PersistApprovalInput, now: string): Promise<void>;
  revokeApproval(input: PersistApprovalRevocationInput, now: string): Promise<boolean>;
  lockImportKey(key: string): Promise<void>;
  createUser(candidate: NormalizedAuthUserImportCandidate, now: string): Promise<PersistedAuthUser | undefined>;
  setPassword(userId: string, encoded: string, now: string): Promise<void>;
  lockUserById?(userId: string): Promise<PersistedAuthUser | undefined>;
  getPassword?(userId: string): Promise<{ encoded: string } | undefined>;
  revokeUserSessions?(userId: string, now: string): Promise<number>;
  createResource(resourceType: "session" | "workspace", resourceId: string, userId: string, resourcePath: string | null, now: string): Promise<boolean>;
  insertMapping(mapping: AuthImportMapping): Promise<void>;
  insertRunActions(input: PersistRunAuthorizationInput, now: string): Promise<void>;
  findImportRun(input: PersistRunAuthorizationInput): Promise<"missing" | "match" | "conflict">;
  listLeaseableActions(input: PersistImportLeaseInput, now: string): Promise<AuthImportActionDefinition[]>;
  leaseImportAction(runId: string, actionId: string, tokenHash: string, expiresAt: string): Promise<void>;
  bindImportAction(input: PersistUserImportInput | PersistResourceClaimInput,
    lease: AuthImportActionLeaseBinding, operation: "apply-user" | "claim-resource",
    payloadDigest: string, now: string): Promise<BoundImportAction>;
  completeImportAction(action: BoundImportAction, result: AuthImportActionResult, now: string): Promise<void>;
  listLeaseableOutbox(input: PersistImportLeaseInput, now: string): Promise<ImportOutboxRecord[]>;
  leaseOutboxEvent(eventId: string, tokenHash: string, expiresAt: string): Promise<void>;
  ackOutboxEvent(input: PersistImportOutboxAckInput, tokenHash: string, now: string): Promise<boolean>;
  writeAudit(record: ImportAuditRecord): Promise<void>;
}

export interface AuthImportPersistence {
  read<T>(run: (reader: AuthImportReader) => Promise<T>): Promise<T>;
  transaction<T>(run: (transaction: AuthImportTransaction) => Promise<T>, signal?: AbortSignal): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export class PostgresAuthImportStore implements AuthImportStore {
  constructor(
    private readonly persistence: AuthImportPersistence,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  assertOperator(input: AuthImportContext, now: string = this.clock()): Promise<void> {
    return this.persistence.read((reader) => reader.assertOperator(input.operator, now));
  }

  resolveUser(input: AuthImportContext & { normalizedEmail: string }): Promise<AuthUserResolution> {
    return this.persistence.read(async (reader) => {
      const mapping = await reader.findMapping(input.source);
      if (mapping) return mappingResolution(mapping, input);
      const user = await reader.findUserByEmail(input.normalizedEmail);
      return user ? { kind: "email", userId: user.id } : { kind: "missing" };
    });
  }

  applyUserImport(input: PersistUserImportInput, now: string = this.clock()): Promise<AuthUserImportResult> {
    return this.persistence.transaction(async (transaction) => {
      await authorizeWrite(transaction, input, now);
      const action = await transaction.bindImportAction(
        input,
        input.actionLease,
        "apply-user",
        input.actionLease.payloadDigest,
        now,
      );
      await transaction.lockImportKey(importLockKey("source", sourceKey(input.source)));
      throwIfAborted(input.signal);
      const existingMapping = await transaction.findMapping(input.source);
      const result = existingMapping
        ? replayUser(existingMapping, input)
        : await persistUserImport(transaction, input, now);
      await completeUserAction(transaction, action, result, now);
      return result;
    }, input.signal);
  }

  syncCredential(input: PersistCredentialSyncInput, now: string = this.clock()): Promise<AuthCredentialSyncResult> {
    return this.persistence.transaction(async (transaction) => {
      await authorizeWrite(transaction, input, now);
      if (!transaction.lockUserById || !transaction.getPassword || !transaction.revokeUserSessions) {
        throw new AuthImportError("CREDENTIAL_ROLLBACK_UNAVAILABLE");
      }
      await transaction.lockImportKey(importLockKey("credential", sourceKey(input.source)));
      await transaction.lockImportKey(importLockKey("target", input.targetUserId));
      const mapping = await transaction.findMapping({ ...input.source, sourceType: "user" });
      if (!mapping || mapping.sourceDigest !== input.source.sourceDigest
        || mapping.targetType !== "user" || mapping.targetUserId !== input.targetUserId
        || mapping.rolledBackAt || (mapping.result !== "migrated" && mapping.result !== "merged")) {
        throw new AuthImportError("CREDENTIAL_STATE_CONFLICT");
      }
      const target = await transaction.lockUserById(input.targetUserId);
      if (!target || target.status !== input.expectedStatus || target.role !== input.expectedRole
        || target.defaultMode !== input.expectedDefaultMode) {
        throw new AuthImportError("CREDENTIAL_STATE_CONFLICT");
      }
      const current = await transaction.getPassword(input.targetUserId);
      if (!current) throw new AuthImportError("CREDENTIAL_STATE_CONFLICT");
      const rollbackSnapshot = await input.rollbackStore.load(input.rollbackSnapshotRef);
      if (rollbackSnapshot) {
        if (rollbackSnapshot.targetUserId !== input.targetUserId
          || rollbackSnapshot.sourceDigest !== input.source.sourceDigest
          || rollbackSnapshot.snapshotDigest !== input.snapshotDigest) {
          throw new AuthImportError("CREDENTIAL_STATE_CONFLICT");
        }
      }
      if (current.encoded === input.normalizedEncoded) {
        return { result: "synced", userId: input.targetUserId, revokedSessionCount: 0 };
      }
      if (input.targetUserId === input.operator.userId) {
        throw new AuthImportError("CREDENTIAL_STATE_CONFLICT");
      }
      await input.rollbackStore.save({
        snapshotRef: input.rollbackSnapshotRef,
        targetUserId: input.targetUserId,
        encoded: current.encoded,
        sourceDigest: input.source.sourceDigest,
        snapshotDigest: input.snapshotDigest,
      });
      throwIfAborted(input.signal);
      await transaction.setPassword(input.targetUserId, input.normalizedEncoded, now);
      const revokedSessionCount = await transaction.revokeUserSessions(input.targetUserId, now);
      await transaction.writeAudit(auditRecord("auth.import.credential-sync", input, input.targetUserId, now));
      throwIfAborted(input.signal);
      return { result: "synced", userId: input.targetUserId, revokedSessionCount };
    }, input.signal);
  }

  claimResource(
    input: PersistResourceClaimInput,
    now: string = this.clock(),
  ): Promise<AuthResourceClaimResult> {
    return this.persistence.transaction(async (transaction) => {
      await authorizeWrite(transaction, input, now);
      const action = await transaction.bindImportAction(
        input,
        input.actionLease,
        "claim-resource",
        input.actionLease.payloadDigest,
        now,
      );
      await transaction.lockImportKey(importLockKey("source", sourceKey(input.source)));
      throwIfAborted(input.signal);
      const mapping = await transaction.findMapping(input.source);
      const result = mapping
        ? replayResource(mapping, input)
        : await persistResourceClaim(transaction, input, now);
      await completeResourceAction(transaction, action, result, input.resourceId, now);
      return result;
    }, input.signal);
  }

  authorizeImportRun(
    input: PersistRunAuthorizationInput,
    now: string = this.clock(),
  ): Promise<{ authorized: true }> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      await transaction.lockImportKey(importLockKey("run", input.runId));
      const existing = await transaction.findImportRun(input);
      if (existing === "match") return { authorized: true };
      if (existing === "conflict") {
        throw new AuthImportError("IMPORT_INPUT_INVALID", "import run binding conflict");
      }
      throwIfAborted(input.signal);
      await transaction.consumeApproval(input, input.approval, now);
      throwIfAborted(input.signal);
      await transaction.insertRunActions(input, now);
      await transaction.writeAudit(auditRecord(
        "auth.import.run-authorized",
        input,
        input.operator.userId,
        now,
      ));
      throwIfAborted(input.signal);
      return { authorized: true };
    }, input.signal);
  }

  leaseImportActions(
    input: PersistImportLeaseInput,
    now: string = this.clock(),
  ): Promise<AuthImportActionLease[]> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      const actions = await transaction.listLeaseableActions(input, now);
      return leaseActions(transaction, actions, input.runId, input.leaseMs, now);
    }, input.signal);
  }

  leaseImportOutbox(input: PersistImportLeaseInput, now: string = this.clock()): Promise<AuthImportOutboxLease[]> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      const records = await transaction.listLeaseableOutbox(input, now);
      return leaseOutbox(transaction, records, input.leaseMs, now);
    }, input.signal);
  }

  listImportOutboxReceipts(input: PersistImportOutboxReceiptInput, now: string = this.clock()): Promise<AuthImportOutboxReceipt[]> {
    return this.persistence.read(async (reader) => {
      await reader.assertOperator(input.operator, now);
      const receipts = await reader.listOutboxReceipts(input);
      throwIfAborted(input.signal);
      return receipts;
    });
  }

  ackImportOutbox(input: PersistImportOutboxAckInput, now: string = this.clock()): Promise<boolean> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      return transaction.ackOutboxEvent(input, hashOpaqueToken(input.leaseToken), now);
    }, input.signal);
  }

  reconcileImport(input: PersistReconcileInput): Promise<AuthImportReconciliation> {
    return this.persistence.read(async (reader) => {
      if (input.source.sourceType === "manifest") {
        return reconcileRun(reader, input);
      }
      const mapping = await reader.findMapping(input.source);
      if (!mapping) return { matched: 0, missing: 1, mismatched: 0 };
      const matches = await mappingMatchesTarget(reader, mapping, input.source);
      return matches
        ? { matched: 1, missing: 0, mismatched: 0 }
        : { matched: 0, missing: 0, mismatched: 1 };
    });
  }

  rollbackImport(input: PersistRollbackInput, now: string = this.clock()): Promise<AuthImportRollbackResult> {
    return this.persistence.transaction(async (transaction) => {
      await authorizeWrite(transaction, input, now);
      const mappings = await transaction.listMappings(input.runId, input.planId, input.source.sourceSystem);
      const rejected = mappings.filter((mapping) => mapping.createdTarget && !mapping.rolledBackAt).length;
      const result = {
        rolledBack: 0,
        retained: mappings.length,
        rejected,
        reasonCode: "ROLLBACK_GUARD_UNAVAILABLE",
      };
      await transaction.writeAudit(auditRecord("auth.import.rollback-blocked", input, input.operator.userId, now));
      throwIfAborted(input.signal);
      return result;
    }, input.signal);
  }

  issueApproval(input: PersistApprovalInput, now: string = this.clock()): Promise<void> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      throwIfAborted(input.signal);
      await transaction.insertApproval(input, now);
      throwIfAborted(input.signal);
      await transaction.writeAudit(auditRecord(
        "auth.import.approval-issued",
        input,
        input.operator.userId,
        now,
      ));
      throwIfAborted(input.signal);
    }, input.signal);
  }

  revokeApproval(input: PersistApprovalRevocationInput, now: string = this.clock()): Promise<boolean> {
    return this.persistence.transaction(async (transaction) => {
      await transaction.assertOperator(input.operator, now);
      throwIfAborted(input.signal);
      const revoked = await transaction.revokeApproval(input, now);
      throwIfAborted(input.signal);
      await transaction.writeAudit(auditRecord(
        revoked ? "auth.import.approval-revoked" : "auth.import.approval-revoke-rejected",
        input,
        input.operator.userId,
        now,
      ));
      throwIfAborted(input.signal);
      return revoked;
    }, input.signal);
  }

  close(): Promise<void> { return this.persistence.close(); }
}

async function reconcileRun(
  reader: AuthImportReader,
  input: PersistReconcileInput,
): Promise<AuthImportReconciliation> {
  const actions = await reader.listRunActions(input);
  if (!actions) return { matched: 0, missing: 1, mismatched: 0 };
  let matched = 0;
  let missing = 0;
  let mismatched = 0;
  for (const action of actions) {
    const mapping = await reader.findMapping(action.source);
    if (!mapping) {
      missing += 1;
    } else if (mapping.runId !== input.runId || mapping.planId !== input.planId
      || !await mappingMatchesTarget(reader, mapping, action.source)) {
      mismatched += 1;
    } else {
      matched += 1;
    }
  }
  return { matched, missing, mismatched };
}

async function persistUserImport(
  transaction: AuthImportTransaction,
  input: PersistUserImportInput,
  now: string,
): Promise<AuthUserImportResult> {
  await transaction.lockImportKey(importLockKey("email", input.candidate.email));
  throwIfAborted(input.signal);
  let existing = await transaction.findUserByEmail(input.candidate.email);
  if (existing && targetUserConflict(existing, input.candidate)) {
    return persistRejectedUser(transaction, input, existing, now);
  }
  let user = existing;
  let created = false;
  if (!user) {
    user = await transaction.createUser(input.candidate, now);
    created = Boolean(user);
    if (!user) {
      existing = await transaction.findUserByEmail(input.candidate.email);
      if (!existing || targetUserConflict(existing, input.candidate)) {
        throw new AuthImportError("IMPORT_INPUT_INVALID", "target user changed during import");
      }
      user = existing;
    }
  }
  throwIfAborted(input.signal);
  if (created && input.credential.action === "reuse") {
    await transaction.setPassword(user.id, input.credential.normalizedEncoded, now);
  }
  throwIfAborted(input.signal);
  const result = created
    ? input.credential.action === "reuse" ? "migrated" : "reset_required"
    : "merged";
  await transaction.insertMapping(mappingForUser(input, user.id, result, created, now));
  throwIfAborted(input.signal);
  await transaction.writeAudit(auditRecord("auth.import.user", input, user.id, now));
  throwIfAborted(input.signal);
  return { result, userId: user.id, mappingCreated: true };
}

function targetUserConflict(
  user: PersistedAuthUser,
  candidate: NormalizedAuthUserImportCandidate,
): boolean {
  return user.status !== "active"
    || user.role !== candidate.role
    || user.defaultMode !== candidate.defaultMode;
}

async function persistRejectedUser(
  transaction: AuthImportTransaction,
  input: PersistUserImportInput,
  user: PersistedAuthUser,
  now: string,
): Promise<AuthUserImportResult> {
  const reasonCode = user.status === "disabled"
    ? "TARGET_USER_DISABLED"
    : user.status === "pending" ? "TARGET_USER_NOT_ACTIVE" : "ROLE_CONFLICT";
  await transaction.insertMapping(mappingForUser(input, user.id, "rejected", false, now, reasonCode));
  await transaction.writeAudit(auditRecord("auth.import.user-rejected", input, user.id, now));
  return { result: "rejected", userId: user.id, mappingCreated: true, reasonCode };
}

async function persistResourceClaim(
  transaction: AuthImportTransaction,
  input: PersistResourceClaimInput,
  now: string,
): Promise<AuthResourceClaimResult> {
  await transaction.lockImportKey(importLockKey("resource", `${input.resourceType}\0${input.resourceId}`));
  throwIfAborted(input.signal);
  const user = await transaction.findUserById(input.targetUserId);
  if (!user || user.status !== "active") {
    return persistRejectedResource(transaction, input, "TARGET_USER_NOT_ACTIVE", now);
  }
  const existing = await transaction.findResource(input.resourceType, input.resourceId);
  if (existing && existing.userId !== input.targetUserId) {
    return persistRejectedResource(transaction, input, "RESOURCE_OWNERSHIP_CONFLICT", now);
  }
  let created = !existing;
  if (created) {
    created = await transaction.createResource(
      input.resourceType,
      input.resourceId,
      input.targetUserId,
      input.resourcePath ?? null,
      now,
    );
    if (!created) {
      const raced = await transaction.findResource(input.resourceType, input.resourceId);
      if (!raced || raced.userId !== input.targetUserId) {
        return persistRejectedResource(transaction, input, "RESOURCE_OWNERSHIP_CONFLICT", now);
      }
    }
  }
  throwIfAborted(input.signal);
  const result = created ? "claimed" : "unchanged";
  await transaction.insertMapping(mappingForResource(input, result, created, now));
  throwIfAborted(input.signal);
  await transaction.writeAudit(auditRecord("auth.import.resource", input, input.targetUserId, now));
  throwIfAborted(input.signal);
  return { result, userId: input.targetUserId };
}

async function persistRejectedResource(
  transaction: AuthImportTransaction,
  input: PersistResourceClaimInput,
  reasonCode: string,
  now: string,
): Promise<AuthResourceClaimResult> {
  await transaction.insertMapping(mappingForResource(input, "rejected", false, now, reasonCode));
  await transaction.writeAudit(auditRecord("auth.import.resource-rejected", input, null, now));
  return { result: "rejected", reasonCode };
}

function mappingForUser(
  input: PersistUserImportInput,
  userId: string,
  result: AuthUserImportResult["result"],
  createdTarget: boolean,
  now: string,
  reasonCode: string | null = null,
): AuthImportMapping {
  return {
    ...input.source,
    runId: input.runId,
    planId: input.planId,
    targetType: "user",
    targetId: userId,
    targetUserId: userId,
    result,
    reasonCode,
    createdTarget,
    createdAt: now,
    rolledBackAt: null,
  };
}

function mappingForResource(
  input: PersistResourceClaimInput,
  result: "claimed" | "unchanged" | "rejected",
  createdTarget: boolean,
  now: string,
  reasonCode: string | null = null,
): AuthImportMapping {
  return {
    ...input.source,
    runId: input.runId,
    planId: input.planId,
    targetType: input.resourceType,
    targetId: input.resourceId,
    targetUserId: input.targetUserId,
    result,
    reasonCode,
    createdTarget,
    createdAt: now,
    rolledBackAt: null,
  };
}

function replayUser(mapping: AuthImportMapping, input: AuthImportContext): AuthUserImportResult {
  assertReplay(mapping, input);
  if (mapping.targetType !== "user" || !isUserResult(mapping.result)) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "source triple belongs to another target type");
  }
  return {
    result: mapping.result,
    ...(mapping.targetUserId ? { userId: mapping.targetUserId } : {}),
    mappingCreated: false,
    ...(mapping.reasonCode ? { reasonCode: mapping.reasonCode } : {}),
  };
}

function replayResource(mapping: AuthImportMapping, input: AuthImportContext): AuthResourceClaimResult {
  assertReplay(mapping, input);
  if (mapping.result === "rejected") return { result: "rejected", reasonCode: mapping.reasonCode ?? "REJECTED" };
  if ((mapping.result !== "claimed" && mapping.result !== "unchanged") || !mapping.targetUserId) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "source triple belongs to another target type");
  }
  return { result: mapping.result, userId: mapping.targetUserId };
}

function mappingResolution(mapping: AuthImportMapping, input: AuthImportContext): AuthUserResolution {
  if (mapping.rolledBackAt) return { kind: "conflict", reason: "IMPORT_ALREADY_ROLLED_BACK" };
  if (mapping.sourceDigest !== input.source.sourceDigest) {
    return { kind: "conflict", reason: "SOURCE_DIGEST_MISMATCH" };
  }
  if (mapping.runId !== input.runId || mapping.planId !== input.planId) {
    return { kind: "conflict", reason: "SOURCE_TARGET_CONFLICT" };
  }
  return mapping.targetType === "user" && mapping.targetUserId
    ? { kind: "mapping", userId: mapping.targetUserId }
    : { kind: "conflict", reason: "SOURCE_TARGET_CONFLICT" };
}

function assertReplay(mapping: AuthImportMapping, input: AuthImportContext): void {
  if (mapping.rolledBackAt) throw new AuthImportError("IMPORT_ALREADY_ROLLED_BACK");
  if (mapping.sourceDigest !== input.source.sourceDigest) throw new AuthImportError("SOURCE_DIGEST_MISMATCH");
  if (mapping.runId !== input.runId || mapping.planId !== input.planId) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "source triple belongs to another import run");
  }
}

function isUserResult(result: MappingResult): result is AuthUserImportResult["result"] {
  return result === "migrated" || result === "merged" || result === "rejected" || result === "reset_required";
}

async function authorizeWrite(
  transaction: AuthImportTransaction,
  input: AuthWriteContext,
  now: string,
): Promise<void> {
  await transaction.assertOperator(input.operator, now);
  throwIfAborted(input.signal);
  const approval = (input as
    | PersistUserImportInput
    | PersistResourceClaimInput
    | PersistRollbackInput
    | PersistCredentialSyncInput
    | PersistRunAuthorizationInput).approval;
  await transaction.consumeApproval(input, approval, now);
  throwIfAborted(input.signal);
}

async function mappingMatchesTarget(
  reader: AuthImportReader,
  mapping: AuthImportMapping,
  source: AuthImportSource,
): Promise<boolean> {
  if (mapping.sourceDigest !== source.sourceDigest || mapping.rolledBackAt) return false;
  if (mapping.result === "rejected") return true;
  if (mapping.targetType === "user") {
    return Boolean(mapping.targetUserId && await reader.findUserById(mapping.targetUserId));
  }
  if (!mapping.targetId || !mapping.targetUserId) return false;
  const resource = await reader.findResource(mapping.targetType, mapping.targetId);
  return resource?.userId === mapping.targetUserId;
}

function auditRecord(
  action: string,
  input: AuthImportContext,
  userId: string | null,
  now: string,
): ImportAuditRecord {
  return {
    action,
    userId,
    requestId: input.operator.requestId,
    metadata: {
      runId: input.runId,
      planId: input.planId,
      sourceKeyHash: sourceKeyHash(input.source),
      sourceDigest: input.source.sourceDigest,
    },
    createdAt: now,
  };
}

function sourceKeyHash(source: AuthImportSource): string {
  return createHash("sha256")
    .update([source.sourceSystem, source.sourceType, source.sourceId].join("\0"))
    .digest("hex");
}

function sourceKey(source: AuthImportSource): string {
  return [source.sourceSystem, source.sourceType, source.sourceId].join("\0");
}

function importLockKey(namespace: string, key: string): string {
  return `auth-import\0${namespace}\0${key}`;
}
export { PgAuthImportPersistence } from "./postgres-import-persistence.js";
export type { AuthImportMapping, PersistedAuthUser } from "./postgres-import-rows.js";
