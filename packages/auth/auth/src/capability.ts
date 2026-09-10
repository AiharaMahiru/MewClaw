import type { Scope } from "dsh-lark-contracts";

export type AuthImportSourceType =
  | "manifest"
  | "user"
  | "credential"
  | "identity"
  | "workspace"
  | "session";

export interface AuthImportSource {
  sourceSystem: string;
  sourceType: AuthImportSourceType;
  sourceId: string;
  sourceDigest: string;
}

export interface AuthOperator {
  userId: string;
  sessionId: string;
  requestId: string;
}

export interface AuthImportContext {
  scope: Scope;
  operator: AuthOperator;
  runId: string;
  planId: string;
  snapshotDigest: string;
  source: AuthImportSource;
  signal?: AbortSignal;
}

export interface AuthWriteContext extends AuthImportContext {
  approvalRef: string;
  cutoverEpochId: string;
}

export interface AuthUserImportCandidate {
  email: string;
  displayName: string;
  role: "admin" | "user";
  defaultMode: "full" | "lightweight";
  status: "active" | "disabled";
  passwordEncoded?: string;
}

export type CredentialImportDecision =
  | {
    action: "reuse";
    algorithm: "scrypt";
    profile: "dsh-native" | "dooragent-scrypt-v1";
  }
  | { action: "reset_required"; reason: string };

export type AuthUserResolution =
  | { kind: "missing" }
  | { kind: "mapping" | "email"; userId: string }
  | { kind: "conflict"; reason: string };

export interface AuthUserImportPlan {
  decision: "create" | "merge" | "reject";
  targetUserId?: string;
  credential: CredentialImportDecision;
  candidateDigest: string;
  reasonCode?: string;
}

export interface AuthUserImportResult {
  result: "migrated" | "merged" | "rejected" | "reset_required";
  userId?: string;
  mappingCreated: boolean;
  reasonCode?: string;
}

export type AuthResourceClaimResult =
  | { result: "claimed" | "unchanged"; userId: string }
  | { result: "rejected"; reasonCode: string };

export interface AuthImportReconciliation {
  matched: number;
  missing: number;
  mismatched: number;
}

export interface AuthImportRollbackResult {
  rolledBack: number;
  retained: number;
  rejected: number;
  reasonCode?: string;
}

export type AuthImportOperation =
  | "apply-run"
  | "apply-user"
  | "claim-resource"
  | "rollback-run"
  | "sync-credential";

export interface AuthCredentialRollbackSnapshot {
  snapshotRef: string;
  targetUserId: string;
  encoded: string;
  sourceDigest: string;
  snapshotDigest: string;
}

export interface AuthCredentialRollbackStore {
  /**
   * 将旧凭证写入已有的加密、最小权限回滚承载。
   * 实现必须保证引用幂等，且不得把 encoded 写入日志或普通文件。
   */
  save(input: AuthCredentialRollbackSnapshot): Promise<void>;
  load(snapshotRef: string): Promise<AuthCredentialRollbackSnapshot | undefined>;
}

export interface AuthCredentialSyncInput extends AuthWriteContext {
  targetUserId: string;
  expectedRole: "admin" | "user";
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  sourceCredential: string;
  credentialDigest: string;
  rollbackSnapshotRef: string;
}

export interface AuthCredentialSyncResult {
  result: "synced";
  userId: string;
  revokedSessionCount: number;
}

export interface AuthImportActionDefinition {
  actionId: string;
  operation: "apply-user" | "claim-resource";
  sequence: number;
  source: AuthImportSource;
  payloadDigest: string;
}

export interface AuthImportActionLeaseBinding {
  actionId: string;
  leaseToken: string;
  payloadDigest: string;
}

export interface AuthImportActionLease extends AuthImportActionDefinition {
  leaseToken: string;
  leaseExpiresAt: string;
}

export type AuthImportActionResult =
  | {
    operation: "apply-user";
    result: AuthUserImportResult["result"];
    targetUserId: string | null;
    reasonCode: string | null;
  }
  | {
    operation: "claim-resource";
    result: AuthResourceClaimResult["result"];
    targetUserId: string | null;
    targetResourceId: string | null;
    reasonCode: string | null;
  };

export interface AuthImportOutboxLease {
  eventId: string;
  actionId: string;
  sequence: number;
  result: AuthImportActionResult;
  occurredAt: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AuthImportOutboxReceipt extends Omit<AuthImportOutboxLease, "leaseToken" | "leaseExpiresAt"> {
  acknowledgedAt: string | null;
}

export interface AuthImportLeaseInput extends AuthImportContext {
  cutoverEpochId: string;
  limit: number;
  leaseMs: number;
}

export interface AuthImportOutboxReceiptInput extends AuthImportContext {
  cutoverEpochId: string;
  afterSequence: number;
  limit: number;
}

export type AuthImportApprovalIssueInput = AuthImportContext & {
  cutoverEpochId: string;
} & (
  | {
    operation: "apply-run";
    planDigest: string;
    actions: readonly AuthImportActionDefinition[];
  }
  | { operation: "apply-user"; candidateDigest: string }
  | {
    operation: "claim-resource";
    resourceType: "session" | "workspace";
    resourceId: string;
    resourcePath?: string;
    targetUserId: string;
  }
  | {
    operation: "sync-credential";
    targetUserId: string;
    expectedRole: "admin" | "user";
    expectedDefaultMode: "full" | "lightweight";
    expectedStatus: "active";
    credentialDigest: string;
    rollbackSnapshotRef: string;
  }
  | { operation: "rollback-run" }
);

export interface AuthImportApprovalIssueResult {
  approvalRef: string;
  expiresAt: string;
}

export interface AuthImportApprovalRevokeInput extends AuthImportContext {
  approvalRef: string;
}

export interface AuthImportApprovalRevokeResult {
  revoked: true;
}

export interface AuthImportRunAuthorizeInput extends AuthWriteContext {
  planDigest: string;
  actions: readonly AuthImportActionDefinition[];
}

export const DEFAULT_AUTH_IMPORT_APPROVAL_TTL_MS = 900_000;
export const MIN_AUTH_IMPORT_APPROVAL_TTL_MS = 60_000;
export const MAX_AUTH_IMPORT_APPROVAL_TTL_MS = 3_600_000;

export interface AuthCapability {
  inspectCredential(input: {
    sourceSystem: string;
    encoded: string;
    signal?: AbortSignal;
  }): Promise<CredentialImportDecision>;
  resolveUser(input: AuthImportContext & { normalizedEmail: string }): Promise<AuthUserResolution>;
  dryRunUserImport(input: AuthImportContext & { candidate: AuthUserImportCandidate }): Promise<AuthUserImportPlan>;
  applyUserImport(input: AuthWriteContext & {
    candidate: AuthUserImportCandidate;
    actionLease: AuthImportActionLeaseBinding;
  }): Promise<AuthUserImportResult>;
  syncCredential(input: AuthCredentialSyncInput): Promise<AuthCredentialSyncResult>;
  claimResource(input: AuthWriteContext & {
    resourceType: "session" | "workspace";
    resourceId: string;
    resourcePath?: string;
    targetUserId: string;
    actionLease: AuthImportActionLeaseBinding;
  }): Promise<AuthResourceClaimResult>;
  authorizeImportRun(input: AuthImportRunAuthorizeInput): Promise<{ authorized: true }>;
  leaseImportActions(input: AuthImportLeaseInput): Promise<AuthImportActionLease[]>;
  leaseImportOutbox(input: AuthImportLeaseInput): Promise<AuthImportOutboxLease[]>;
  listImportOutboxReceipts(input: AuthImportOutboxReceiptInput): Promise<AuthImportOutboxReceipt[]>;
  ackImportOutbox(input: AuthImportContext & {
    cutoverEpochId: string;
    eventId: string;
    leaseToken: string;
  }): Promise<{ acked: true }>;
  reconcileImport(input: AuthImportContext): Promise<AuthImportReconciliation>;
  rollbackImport(input: AuthWriteContext): Promise<AuthImportRollbackResult>;
  issueImportApproval(input: AuthImportApprovalIssueInput): Promise<AuthImportApprovalIssueResult>;
  revokeImportApproval(input: AuthImportApprovalRevokeInput): Promise<AuthImportApprovalRevokeResult>;
}

export type AuthImportErrorCode =
  | "IMPORT_ABORTED"
  | "IMPORT_INPUT_INVALID"
  | "IMPORT_NOT_AUTHORIZED"
  | "APPROVAL_INVALID"
  | "ACTION_LEASE_INVALID"
  | "SOURCE_DIGEST_MISMATCH"
  | "IMPORT_ALREADY_ROLLED_BACK"
  | "CREDENTIAL_ROLLBACK_UNAVAILABLE"
  | "CREDENTIAL_SOURCE_INVALID"
  | "CREDENTIAL_STATE_CONFLICT";

export class AuthImportError extends Error {
  constructor(readonly code: AuthImportErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthImportError";
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    auth?: AuthCapability;
  }
}
