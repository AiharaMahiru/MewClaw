import { createHash } from "node:crypto";

import {
  AuthImportError,
  type AuthImportContext,
  type AuthImportReconciliation,
  type AuthImportSource,
  type AuthResourceClaimResult,
  type AuthUserImportResult,
  type AuthUserResolution,
  type AuthWriteContext,
} from "./capability.js";
import type {
  NormalizedAuthUserImportCandidate,
  PersistCredentialSyncInput,
  PersistReconcileInput,
  PersistResourceClaimInput,
  PersistRollbackInput,
  PersistRunAuthorizationInput,
  PersistUserImportInput,
} from "./import-service.js";
import { throwIfAborted } from "./import-validation.js";
import type {
  AuthImportMapping,
  MappingResult,
  PersistedAuthUser,
} from "./postgres-import-rows.js";
import type {
  AuthImportReader,
  AuthImportTransaction,
  ImportAuditRecord,
} from "./postgres-import-store.js";

export async function reconcileRun(
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

export async function persistUserImport(
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

export async function persistResourceClaim(
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

export function replayUser(mapping: AuthImportMapping, input: AuthImportContext): AuthUserImportResult {
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

export function replayResource(mapping: AuthImportMapping, input: AuthImportContext): AuthResourceClaimResult {
  assertReplay(mapping, input);
  if (mapping.result === "rejected") return { result: "rejected", reasonCode: mapping.reasonCode ?? "REJECTED" };
  if ((mapping.result !== "claimed" && mapping.result !== "unchanged") || !mapping.targetUserId) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "source triple belongs to another target type");
  }
  return { result: mapping.result, userId: mapping.targetUserId };
}

export function mappingResolution(mapping: AuthImportMapping, input: AuthImportContext): AuthUserResolution {
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

export async function authorizeWrite(
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

export async function mappingMatchesTarget(
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

export function auditRecord(
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

export function sourceKey(source: AuthImportSource): string {
  return [source.sourceSystem, source.sourceType, source.sourceId].join("\0");
}

export function importLockKey(namespace: string, key: string): string {
  return `auth-import\0${namespace}\0${key}`;
}
