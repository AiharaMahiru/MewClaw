import { createHash } from "node:crypto";

import {
  AuthImportError,
  DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS,
  MAX_AUTH_IMPORT_APPROVAL_TTL_MS,
  MIN_AUTH_IMPORT_APPROVAL_TTL_MS,
  type AuthCapability,
  type AuthCredentialRollbackStore,
  type AuthCredentialSyncInput,
  type AuthCredentialSyncResult,
  type AuthImportActionDefinition,
  type AuthImportActionLease,
  type AuthImportActionLeaseBinding,
  type AuthImportApprovalIssueInput,
  type AuthImportApprovalIssueResult,
  type AuthImportApprovalRevokeInput,
  type AuthImportApprovalRevokeResult,
  type AuthImportContext,
  type AuthImportLeaseInput,
  type AuthImportOperation,
  type AuthImportOutboxLease,
  type AuthImportOutboxReceipt,
  type AuthImportOutboxReceiptInput,
  type AuthImportReconciliation,
  type AuthImportRollbackResult,
  type AuthImportRunAuthorizeInput,
  type AuthResourceClaimResult,
  type AuthUserImportCandidate,
  type AuthUserImportPlan,
  type AuthUserImportResult,
  type AuthUserResolution,
  type AuthWriteContext,
  type CredentialImportDecision,
} from "./capability.js";
import { normalizeEmail } from "./crypto.js";
import { generateOpaqueToken, hashOpaqueToken } from "./crypto.js";
import { inspectImportCredential, type InspectedImportCredential } from "./credential-policy.js";
import {
  credentialSyncPayloadDigest,
  prepareCredentialSync,
  validateCredentialSyncApproval,
} from "./credential-sync.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_IMPORT_ACTIONS = 10_000;
const MAX_IMPORT_LEASE_BATCH = 1_000;
const MIN_IMPORT_LEASE_MS = 1_000;
const MAX_IMPORT_LEASE_MS = 86_400_000;
const ACTION_KEYS = new Set(["actionId", "operation", "sequence", "source", "payloadDigest"]);
const SOURCE_KEYS = new Set(["sourceSystem", "sourceType", "sourceId", "sourceDigest"]);

export interface NormalizedAuthUserImportCandidate extends Omit<AuthUserImportCandidate, "passwordEncoded"> {
  email: string;
  displayName: string;
}

export interface AuthApprovalBinding {
  operation: AuthImportOperation;
  payloadDigest: string;
  scopeDigest: string;
  snapshotDigest: string;
  cutoverEpochId: string;
}

export interface PersistUserImportInput extends AuthWriteContext {
  candidate: NormalizedAuthUserImportCandidate;
  credential: InspectedImportCredential;
  approval: AuthApprovalBinding;
  actionLease: AuthImportActionLeaseBinding;
}

export interface PersistCredentialSyncInput extends AuthCredentialSyncInput {
  normalizedEncoded: string;
  payloadDigest: string;
  snapshotKey: string;
  approval: AuthApprovalBinding;
  rollbackStore: AuthCredentialRollbackStore;
}

export type PersistResourceClaimInput = Parameters<AuthCapability["claimResource"]>[0] & {
  approval: AuthApprovalBinding;
};

export type PersistRollbackInput = AuthWriteContext & { approval: AuthApprovalBinding };

export type PersistRunAuthorizationInput = AuthImportRunAuthorizeInput & {
  approval: AuthApprovalBinding;
  actionsDigest: string;
};

export type PersistApprovalInput = AuthImportContext & {
  operation: AuthImportOperation;
  payloadDigest: string;
  cutoverEpochId: string;
  approvalHash: string;
  scopeDigest: string;
  expiresAt: string;
};

export interface PersistApprovalRevocationInput extends Omit<AuthImportApprovalRevokeInput, "approvalRef"> {
  approvalHash: string;
  scopeDigest: string;
}

export interface PersistImportLeaseInput extends AuthImportLeaseInput {
  scopeDigest: string;
}

export interface PersistImportOutboxReceiptInput extends AuthImportOutboxReceiptInput {
  scopeDigest: string;
}

export interface PersistImportOutboxAckInput extends AuthImportContext {
  cutoverEpochId: string;
  eventId: string;
  leaseToken: string;
  scopeDigest: string;
}

export interface PersistReconcileInput extends AuthImportContext {
  scopeDigest: string;
}

export interface AuthImportStore {
  assertOperator(input: AuthImportContext, now: string): Promise<void>;
  resolveUser(input: AuthImportContext & { normalizedEmail: string }, now: string): Promise<AuthUserResolution>;
  applyUserImport(input: PersistUserImportInput, now: string): Promise<AuthUserImportResult>;
  syncCredential?(input: PersistCredentialSyncInput, now: string): Promise<AuthCredentialSyncResult>;
  claimResource(input: PersistResourceClaimInput, now: string): Promise<AuthResourceClaimResult>;
  authorizeImportRun(input: PersistRunAuthorizationInput, now: string): Promise<{ authorized: true }>;
  leaseImportActions?(input: PersistImportLeaseInput, now: string): Promise<AuthImportActionLease[]>;
  leaseImportOutbox?(input: PersistImportLeaseInput, now: string): Promise<AuthImportOutboxLease[]>;
  listImportOutboxReceipts?(input: PersistImportOutboxReceiptInput, now: string): Promise<AuthImportOutboxReceipt[]>;
  ackImportOutbox?(input: PersistImportOutboxAckInput, now: string): Promise<boolean>;
  reconcileImport(input: PersistReconcileInput, now: string): Promise<AuthImportReconciliation>;
  rollbackImport(input: PersistRollbackInput, now: string): Promise<AuthImportRollbackResult>;
  issueApproval(input: PersistApprovalInput, now: string): Promise<void>;
  revokeApproval(input: PersistApprovalRevocationInput, now: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface AuthCapabilityOptions {
  now?: () => string;
  approvalTtlMs?: number;
  createApprovalRef?: () => string;
  credentialRollbackStore?: AuthCredentialRollbackStore;
}

export class DefaultAuthCapability implements AuthCapability {
  private readonly now: () => string;
  private readonly approvalTtlMs: number;
  private readonly createApprovalRef: () => string;
  private readonly credentialRollbackStore: AuthCredentialRollbackStore | undefined;

  constructor(
    private readonly store: AuthImportStore,
    options: AuthCapabilityOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.approvalTtlMs = resolveApprovalTtl(options.approvalTtlMs);
    this.createApprovalRef = options.createApprovalRef ?? generateOpaqueToken;
    this.credentialRollbackStore = options.credentialRollbackStore;
  }

  async inspectCredential(input: {
    sourceSystem: string;
    encoded: string;
    signal?: AbortSignal;
  }): Promise<CredentialImportDecision> {
    throwIfAborted(input.signal);
    return publicDecision(inspectImportCredential(input));
  }

  async resolveUser(input: AuthImportContext & { normalizedEmail: string }): Promise<AuthUserResolution> {
    validateContext(input);
    const now = this.now();
    await this.store.assertOperator(input, now);
    throwIfAborted(input.signal);
    const result = await this.store.resolveUser({ ...input, normalizedEmail: normalizeEmail(input.normalizedEmail) }, now);
    throwIfAborted(input.signal);
    return result;
  }

  async dryRunUserImport(input: AuthImportContext & {
    candidate: AuthUserImportCandidate;
  }): Promise<AuthUserImportPlan> {
    validateContext(input);
    const now = this.now();
    await this.store.assertOperator(input, now);
    const candidate = normalizeCandidate(input.source.sourceSystem, input.candidate);
    const resolution = await this.store.resolveUser({ ...input, normalizedEmail: candidate.email }, now);
    throwIfAborted(input.signal);
    const credential = inspectCandidateCredential(input.source.sourceSystem, input.candidate.passwordEncoded);
    return buildPlan(candidate, resolution, credential, input.candidate.passwordEncoded);
  }

  async applyUserImport(
    input: Parameters<AuthCapability["applyUserImport"]>[0],
  ): Promise<AuthUserImportResult> {
    validateWriteContext(input);
    validateActionLeaseBinding(input.actionLease);
    const candidate = normalizeCandidate(input.source.sourceSystem, input.candidate);
    const credential = inspectCandidateCredential(input.source.sourceSystem, input.candidate.passwordEncoded);
    const candidateDigest = digestCandidate(candidate, input.candidate.passwordEncoded);
    const result = await this.store.applyUserImport({
      ...input,
      candidate,
      credential,
      approval: approvalBinding(input, "apply-user", candidateDigest),
    }, this.now());
    return result;
  }

  async syncCredential(input: AuthCredentialSyncInput): Promise<AuthCredentialSyncResult> {
    if (!this.credentialRollbackStore) throw new AuthImportError("CREDENTIAL_ROLLBACK_UNAVAILABLE");
    validateWriteContext(input);
    const prepared = prepareCredentialSync(input);
    const sync = this.store.syncCredential;
    if (!sync) throw new AuthImportError("CREDENTIAL_ROLLBACK_UNAVAILABLE");
    return sync.call(this.store, {
      ...input,
      ...prepared,
      approval: approvalBinding(input, "sync-credential", prepared.payloadDigest),
      rollbackStore: this.credentialRollbackStore,
    }, this.now());
  }

  async claimResource(input: Parameters<AuthCapability["claimResource"]>[0]): Promise<AuthResourceClaimResult> {
    validateWriteContext(input);
    validateActionLeaseBinding(input.actionLease);
    requireText(input.resourceId, "resourceId");
    requireText(input.targetUserId, "targetUserId");
    const result = await this.store.claimResource({
      ...input,
      approval: approvalBinding(input, "claim-resource", digestResourceClaim(input)),
    }, this.now());
    return result;
  }

  async authorizeImportRun(input: AuthImportRunAuthorizeInput): Promise<{ authorized: true }> {
    validateWriteContext(input);
    if (input.source.sourceType !== "manifest") invalid("apply-run requires manifest source");
    if (!SHA256_HEX.test(input.planDigest)) invalid("invalid planDigest");
    const actions = validateActionManifest(input.actions, input.source.sourceSystem);
    const result = await this.store.authorizeImportRun({
      ...input,
      actions,
      actionsDigest: digestJson(actions),
      approval: approvalBinding(input, "apply-run", digestRunApproval(input.planDigest, actions)),
    }, this.now());
    return result;
  }

  async leaseImportActions(input: AuthImportLeaseInput): Promise<AuthImportActionLease[]> {
    validateLeaseInput(input);
    const lease = this.store.leaseImportActions;
    if (!lease) return invalid("import action store unavailable");
    return lease.call(this.store, { ...input, scopeDigest: digestScope(input) }, this.now());
  }

  async leaseImportOutbox(input: AuthImportLeaseInput): Promise<AuthImportOutboxLease[]> {
    validateLeaseInput(input);
    const lease = this.store.leaseImportOutbox;
    if (!lease) return invalid("import outbox store unavailable");
    return lease.call(this.store, { ...input, scopeDigest: digestScope(input) }, this.now());
  }

  async listImportOutboxReceipts(input: AuthImportOutboxReceiptInput): Promise<AuthImportOutboxReceipt[]> {
    validateReceiptInput(input);
    const list = this.store.listImportOutboxReceipts;
    if (!list) return invalid("import outbox receipt store unavailable");
    return list.call(this.store, { ...input, scopeDigest: digestScope(input) }, this.now());
  }

  async ackImportOutbox(input: AuthImportContext & {
    cutoverEpochId: string;
    eventId: string;
    leaseToken: string;
  }): Promise<{ acked: true }> {
    validateManifestContext(input);
    requireText(input.eventId, "eventId");
    requireText(input.leaseToken, "leaseToken");
    const ack = this.store.ackImportOutbox;
    requireText(input.cutoverEpochId, "cutoverEpochId");
    if (!ack || !await ack.call(this.store, { ...input, scopeDigest: digestScope(input) }, this.now())) {
      throw new AuthImportError("ACTION_LEASE_INVALID");
    }
    return { acked: true };
  }

  async reconcileImport(input: AuthImportContext): Promise<AuthImportReconciliation> {
    validateContext(input);
    const now = this.now();
    await this.store.assertOperator(input, now);
    throwIfAborted(input.signal);
    const result = await this.store.reconcileImport({ ...input, scopeDigest: digestScope(input) }, now);
    throwIfAborted(input.signal);
    return result;
  }

  async rollbackImport(input: AuthWriteContext): Promise<AuthImportRollbackResult> {
    validateWriteContext(input);
    if (input.source.sourceType !== "manifest") invalid("rollback requires manifest source");
    const result = await this.store.rollbackImport({
      ...input,
      approval: approvalBinding(input, "rollback-run", digestRollback(input)),
    }, this.now());
    return result;
  }

  async issueImportApproval(input: AuthImportApprovalIssueInput): Promise<AuthImportApprovalIssueResult> {
    validateApprovalIssue(input);
    const now = this.now();
    const payloadDigest = approvalPayloadDigest(input);
    const approvalRef = this.createApprovalRef();
    requireText(approvalRef, "approvalRef");
    const expiresAt = new Date(Date.parse(now) + this.approvalTtlMs).toISOString();
    await this.store.issueApproval({
      ...input,
      payloadDigest,
      approvalHash: hashOpaqueToken(approvalRef),
      scopeDigest: digestScope(input),
      expiresAt,
    }, now);
    return { approvalRef, expiresAt };
  }

  async revokeImportApproval(input: AuthImportApprovalRevokeInput): Promise<AuthImportApprovalRevokeResult> {
    validateContext(input);
    const { approvalRef, ...context } = input;
    requireText(approvalRef, "approvalRef");
    const revoked = await this.store.revokeApproval({
      ...context,
      approvalHash: hashOpaqueToken(approvalRef),
      scopeDigest: digestScope(input),
    }, this.now());
    if (!revoked) throw new AuthImportError("APPROVAL_INVALID");
    return { revoked: true };
  }
}

function resolveApprovalTtl(value = DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS): number {
  if (!Number.isSafeInteger(value)
    || value < MIN_AUTH_IMPORT_APPROVAL_TTL_MS
    || value > MAX_AUTH_IMPORT_APPROVAL_TTL_MS) {
    throw new AuthImportError("IMPORT_INPUT_INVALID", "invalid approvalTtlMs");
  }
  return value;
}

function validateApprovalIssue(input: AuthImportApprovalIssueInput): void {
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

function validateActionManifest(
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

function validateLeaseInput(input: AuthImportLeaseInput): void {
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

function validateReceiptInput(input: AuthImportOutboxReceiptInput): void {
  validateManifestContext(input);
  requireText(input.cutoverEpochId, "cutoverEpochId");
  if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
    invalid("invalid outbox receipt sequence");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_IMPORT_LEASE_BATCH) {
    invalid("invalid outbox receipt limit");
  }
}

function validateManifestContext(input: AuthImportContext): void {
  validateContext(input);
  if (input.source.sourceType !== "manifest") invalid("manifest source required");
}

function approvalPayloadDigest(input: AuthImportApprovalIssueInput): string {
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

function inspectCandidateCredential(sourceSystem: string, encoded: string | undefined): InspectedImportCredential {
  return encoded
    ? inspectImportCredential({ sourceSystem, encoded })
    : { action: "reset_required", reason: "CREDENTIAL_MISSING" };
}

function normalizeCandidate(
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

function buildPlan(
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

function digestCandidate(candidate: NormalizedAuthUserImportCandidate, credential: string | undefined): string {
  return digestJson({ ...candidate, credential: credential ?? null });
}

function digestResourceClaim(input: {
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

function digestRollback(input: AuthImportContext): string {
  return digestJson({ runId: input.runId, planId: input.planId, sourceSystem: input.source.sourceSystem });
}

function digestRunApproval(planDigest: string, actions: readonly AuthImportActionDefinition[]): string {
  return digestJson({ planDigest, actions });
}

function validateActionLeaseBinding(lease: AuthImportActionLeaseBinding): void {
  if (!lease || !SHA256_HEX.test(lease.actionId)) invalid("invalid action lease");
  requireText(lease.leaseToken, "actionLease.leaseToken");
  if (!SHA256_HEX.test(lease.payloadDigest)) invalid("invalid action lease payload");
}

function approvalBinding(
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

function digestScope(input: AuthImportContext): string {
  const scope = input.scope;
  return digestJson([
    scope.tenantId,
    scope.botId,
    scope.deploymentId,
    scope.userId,
    scope.conversationId,
  ]);
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicDecision(inspected: InspectedImportCredential): CredentialImportDecision {
  if (inspected.action === "reset_required") return inspected;
  return { action: "reuse", algorithm: inspected.algorithm, profile: inspected.profile };
}

function validateWriteContext(input: AuthWriteContext): void {
  validateContext(input);
  requireText(input.approvalRef, "approvalRef");
  requireText(input.cutoverEpochId, "cutoverEpochId");
}

function validateContext(input: AuthImportContext): void {
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

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) invalid(`invalid ${field}`);
  return normalized;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuthImportError("IMPORT_ABORTED");
}

function invalid(message: string): never {
  throw new AuthImportError("IMPORT_INPUT_INVALID", message);
}
