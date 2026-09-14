import { createHash } from "node:crypto";

import {
  AuthImportError,
  DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS,
  MAX_AUTH_IMPORT_APPROVAL_TTL_MS,
  MIN_AUTH_IMPORT_APPROVAL_TTL_MS,
  type AuthImportActionDefinition,
  type AuthImportActionLeaseBinding,
  type AuthImportApprovalIssueInput,
  type AuthImportContext,
  type AuthImportLeaseInput,
  type AuthImportOperation,
  type AuthImportOutboxReceiptInput,
  type AuthUserImportCandidate,
  type AuthUserImportPlan,
  type AuthUserResolution,
  type AuthWriteContext,
  type CredentialImportDecision,
} from "./capability.js";
import { normalizeEmail } from "./crypto.js";
import { inspectImportCredential, type InspectedImportCredential } from "./credential-policy.js";
import {
  credentialSyncPayloadDigest,
  validateCredentialSyncApproval,
} from "./credential-sync.js";
import type {
  AuthApprovalBinding,
  NormalizedAuthUserImportCandidate,
} from "./import-service.js";

export const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_IMPORT_ACTIONS = 10_000;
const MAX_IMPORT_LEASE_BATCH = 1_000;
const MIN_IMPORT_LEASE_MS = 1_000;
const MAX_IMPORT_LEASE_MS = 86_400_000;
const ACTION_KEYS = new Set(["actionId", "operation", "sequence", "source", "payloadDigest"]);
const SOURCE_KEYS = new Set(["sourceSystem", "sourceType", "sourceId", "sourceDigest"]);

export function resolveApprovalTtl(value = DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS): number {
  if (!Number.isSafeInteger(value)
    || value < MIN_AUTH_IMPORT_APPROVAL_TTL_MS
    || value > MAX_AUTH_IMPORT_APPROVAL_TTL_MS) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "invalid approvalTtlMs");
  }
  return value;
}

export function validateApprovalIssue(input: AuthImportApprovalIssueInput): void {
  validateContext(input);
  requireText(input.cutoverEpochId, "cutoverEpochId");
  switch (input.operation) {
    case "apply-run":
      if (input.source.sourceType !== "manifest") invalid("apply-run source mismatch");
      if (!SHA256_HEX.test(input.planDigest)) invalid("invalid planDigest");
      validateActionManifest(input.actions, input.source.sourceSystem);
      return;
    case "apply-user":
      if (input.source.sourceType !== "user") invalid("apply-user source mismatch");
      if (!SHA256_HEX.test(input.candidateDigest)) invalid("invalid candidateDigest");
      return;
    case "sync-credential":
      validateCredentialSyncApproval(input);
      return;
    case "claim-resource":
      if (input.source.sourceType !== "session" && input.source.sourceType !== "workspace") {
        invalid("claim-resource requires session or workspace source");
      }
      requireText(input.resourceId, "resourceId");
      requireText(input.targetUserId, "targetUserId");
      return;
    case "rollback-run":
      if (input.source.sourceType !== "manifest") invalid("rollback-run source mismatch");
      return;
    default:
      invalid("invalid operation");
  }
}

export function validateActionManifest(
  actions: readonly AuthImportActionDefinition[],
  sourceSystem: string,
): AuthImportActionDefinition[] {
  if (!Array.isArray(actions) || actions.length > MAX_IMPORT_ACTIONS) invalid("invalid import actions");
  const ids = new Set<string>();
  const sources = new Set<string>();
  return actions.map((action, index) => {
    validateAction(action, index + 1, sourceSystem);
    const sourceKey = `${action.source.sourceType}\0${action.source.sourceId}`;
    if (ids.has(action.actionId) || sources.has(sourceKey)) invalid("duplicate import action");
    ids.add(action.actionId);
    sources.add(sourceKey);
    return canonicalAction(action);
  });
}

function validateAction(action: AuthImportActionDefinition, sequence: number, sourceSystem: string): void {
  if (!action || typeof action !== "object" || !hasOnlyKeys(action, ACTION_KEYS)
    || !action.source || typeof action.source !== "object" || !hasOnlyKeys(action.source, SOURCE_KEYS)) {
    invalid("invalid import action shape");
  }
  if (!SHA256_HEX.test(action.actionId) || !SHA256_HEX.test(action.payloadDigest)) {
    invalid("invalid import action digest");
  }
  if (action.sequence !== sequence || action.source.sourceSystem !== sourceSystem) {
    invalid("invalid import action binding");
  }
  if (!SHA256_HEX.test(action.source.sourceDigest)) invalid("invalid import action source digest");
  const expected = action.source.sourceType === "user" ? "apply-user"
    : action.source.sourceType === "session" || action.source.sourceType === "workspace"
      ? "claim-resource" : null;
  if (action.operation !== expected) invalid("invalid import action operation");
  requireText(action.source.sourceId, "action.sourceId");
}

function canonicalAction(action: AuthImportActionDefinition): AuthImportActionDefinition {
  return {
    actionId: action.actionId,
    operation: action.operation,
    sequence: action.sequence,
    source: {
      sourceSystem: action.source.sourceSystem,
      sourceType: action.source.sourceType,
      sourceId: action.source.sourceId,
      sourceDigest: action.source.sourceDigest,
    },
    payloadDigest: action.payloadDigest,
  };
}

function hasOnlyKeys(value: object, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

export function validateLeaseInput(input: AuthImportLeaseInput): void {
  validateManifestContext(input);
  requireText(input.cutoverEpochId, "cutoverEpochId");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_IMPORT_LEASE_BATCH) {
    invalid("invalid import lease limit");
  }
  if (!Number.isSafeInteger(input.leaseMs)
    || input.leaseMs < MIN_IMPORT_LEASE_MS || input.leaseMs > MAX_IMPORT_LEASE_MS) {
    invalid("invalid import lease duration");
  }
}

export function validateReceiptInput(input: AuthImportOutboxReceiptInput): void {
  validateManifestContext(input);
  requireText(input.cutoverEpochId, "cutoverEpochId");
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
    invalid("invalid outbox receipt sequence");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_IMPORT_LEASE_BATCH) {
    invalid("invalid outbox receipt limit");
  }
}

export function validateManifestContext(input: AuthImportContext): void {
  validateContext(input);
  if (input.source.sourceType !== "manifest") invalid("manifest source required");
}

export function approvalPayloadDigest(input: AuthImportApprovalIssueInput): string {
  switch (input.operation) {
    case "apply-run": {
      const actions = validateActionManifest(input.actions, input.source.sourceSystem);
      return digestRunApproval(input.planDigest, actions);
    }
    case "apply-user": return input.candidateDigest;
    case "sync-credential": return credentialSyncPayloadDigest(input);
    case "claim-resource": return digestResourceClaim(input);
    case "rollback-run": return digestRollback(input);
    default: return invalid("invalid operation");
  }
}

export function inspectCandidateCredential(sourceSystem: string, encoded: string | undefined): InspectedImportCredential {
  return encoded
    ? inspectImportCredential({ sourceSystem, encoded })
    : { action: "reset_required", reason: "CREDENTIAL_MISSING" };
}

export function normalizeCandidate(
  sourceSystem: string,
  candidate: AuthUserImportCandidate,
): NormalizedAuthUserImportCandidate {
  if (candidate.role !== "admin" && candidate.role !== "user") invalid("invalid role");
  const expectedMode = candidate.role === "admin" ? "full" : "lightweight";
  if (candidate.defaultMode !== expectedMode) invalid("role/defaultMode mismatch");
  if (candidate.status !== "active" && candidate.status !== "disabled") invalid("invalid status");
  const displayName = candidate.displayName.trim();
  if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) invalid("invalid displayName");
  const identities = (candidate as AuthUserImportCandidate & { identities?: unknown[] }).identities;
  if (identities?.length) invalid(`${sourceSystem} identity import is unsupported`);
  return {
    email: normalizeEmail(candidate.email),
    displayName,
    role: candidate.role,
    defaultMode: candidate.defaultMode,
    status: candidate.status,
  };
}

export function buildPlan(
  candidate: NormalizedAuthUserImportCandidate,
  resolution: AuthUserResolution,
  inspected: InspectedImportCredential,
  sourceCredential: string | undefined,
): AuthUserImportPlan {
  const credential = publicDecision(inspected);
  const candidateDigest = digestCandidate(candidate, sourceCredential);
  if (resolution.kind === "conflict") {
    return { decision: "reject", credential, candidateDigest, reasonCode: resolution.reason };
  }
  if (resolution.kind === "missing") return { decision: "create", credential, candidateDigest };
  return { decision: "merge", targetUserId: resolution.userId, credential, candidateDigest };
}

export function digestCandidate(candidate: NormalizedAuthUserImportCandidate, credential: string | undefined): string {
  return digestJson({ ...candidate, credential: credential ?? null });
}

export function digestResourceClaim(input: {
  resourceType: "session" | "workspace";
  resourceId: string;
  resourcePath?: string;
  targetUserId: string;
}): string {
  return digestJson({
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourcePath: input.resourcePath ?? null,
    targetUserId: input.targetUserId,
  });
}

export function digestRollback(input: AuthImportContext): string {
  return digestJson({ runId: input.runId, planId: input.planId, sourceSystem: input.source.sourceSystem });
}

export function digestRunApproval(planDigest: string, actions: readonly AuthImportActionDefinition[]): string {
  return digestJson({ planDigest, actions });
}

export function validateActionLeaseBinding(lease: AuthImportActionLeaseBinding): void {
  if (!lease || !SHA256_HEX.test(lease.actionId)) invalid("invalid action lease");
  requireText(lease.leaseToken, "actionLease.leaseToken");
  if (!SHA256_HEX.test(lease.payloadDigest)) invalid("invalid action lease payload");
}

export function approvalBinding(
  input: AuthWriteContext,
  operation: AuthImportOperation,
  payloadDigest: string,
): AuthApprovalBinding {
  return {
    operation,
    payloadDigest,
    scopeDigest: digestScope(input),
    snapshotDigest: input.snapshotDigest,
    cutoverEpochId: input.cutoverEpochId,
  };
}

export function digestScope(input: AuthImportContext): string {
  const scope = input.scope;
  return digestJson([
    scope.tenantId,
    scope.botId,
    scope.deploymentId,
    scope.userId,
    scope.conversationId,
  ]);
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function publicDecision(inspected: InspectedImportCredential): CredentialImportDecision {
  if (inspected.action === "reset_required") return inspected;
  return { action: "reuse", algorithm: inspected.algorithm, profile: inspected.profile };
}

export function validateWriteContext(input: AuthWriteContext): void {
  validateContext(input);
  requireText(input.approvalRef, "approvalRef");
  requireText(input.cutoverEpochId, "cutoverEpochId");
}

export function validateContext(input: AuthImportContext): void {
  throwIfAborted(input.signal);
  requireText(input.runId, "runId");
  requireText(input.planId, "planId");
  requireText(input.operator.userId, "operator.userId");
  requireText(input.operator.sessionId, "operator.sessionId");
  requireText(input.operator.requestId, "operator.requestId");
  requireText(input.scope.tenantId, "scope.tenantId");
  requireText(input.scope.botId, "scope.botId");
  requireText(input.scope.deploymentId, "scope.deploymentId");
  requireText(input.scope.userId, "scope.userId");
  requireText(input.scope.conversationId, "scope.conversationId");
  if (input.scope.userId !== input.operator.userId) invalid("scope/operator mismatch");
  requireText(input.source.sourceSystem, "sourceSystem");
  requireText(input.source.sourceType, "sourceType");
  requireText(input.source.sourceId, "sourceId");
  if (!SHA256_HEX.test(input.snapshotDigest)) invalid("invalid snapshotDigest");
  if (!SHA256_HEX.test(input.source.sourceDigest)) invalid("invalid sourceDigest");
}

export function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) invalid(`invalid ${field}`);
  return normalized;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuthImportError("IMPORT_ABORTED");
}

export function invalid(message: string): never {
  throw new AuthImportError("IMPORT_INPUT_INVALID", message);
}
