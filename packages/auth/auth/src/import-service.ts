import {
  AuthImportError,
  type AuthCapability,
  type AuthCredentialRollbackStore,
  type AuthCredentialSyncInput,
  type AuthCredentialSyncResult,
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
import { prepareCredentialSync } from "./credential-sync.js";
import {
  approvalBinding,
  approvalPayloadDigest,
  buildPlan,
  digestCandidate,
  digestJson,
  digestResourceClaim,
  digestRollback,
  digestRunApproval,
  digestScope,
  inspectCandidateCredential,
  invalid,
  normalizeCandidate,
  publicDecision,
  requireText,
  resolveApprovalTtl,
  SHA256_HEX,
  throwIfAborted,
  validateActionLeaseBinding,
  validateActionManifest,
  validateApprovalIssue,
  validateContext,
  validateLeaseInput,
  validateManifestContext,
  validateReceiptInput,
  validateWriteContext,
} from "./import-validation.js";

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
