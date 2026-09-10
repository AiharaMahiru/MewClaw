export interface FrozenDoorAgentSource {
  snapshotPath: string;
  manifestPath: string;
  manifestDigest: string;
}

export type DoorAgentRole = "admin" | "user";
export type DoorAgentStatus = "active" | "disabled";

export interface MigrationInventoryUser {
  sourceId: string;
  sourceDigest: string;
  role: DoorAgentRole;
  status: DoorAgentStatus;
}

export interface MigrationInventory {
  sourceSystem: "dooragent";
  snapshotDigest: string;
  manifestVersion: number;
  inventoryDigest: string;
  counts: Array<{ sourceType: "user"; count: number }>;
  users: MigrationInventoryUser[];
}

export interface DoorAgentUserRecord extends MigrationInventoryUser {
  email: string;
  displayName: string;
  passwordEncoded: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  userGroup: string;
}

export interface WorkspaceAggregate {
  bytes: number;
  directoryCount: number;
  fileCount: number;
  merkleRootSha256: string;
  specialFileCount: number;
  symlinkCount: number;
  unreadableEntries: number;
  unstableFiles: number;
}

export interface DoorAgentWorkspaceRecord {
  sourceUserId: string;
  rootPathSha256: string;
  sourceDigest: string;
  status: "manifested" | "missing";
  aggregate: WorkspaceAggregate | null;
  workspaceRoot: string;
}

export interface LoadedDoorAgentSource {
  inventory: MigrationInventory;
  records: DoorAgentUserRecord[];
  workspaces?: DoorAgentWorkspaceRecord[];
}

export interface MigrationActor {
  scope: Scope;
  operator: AuthOperator;
}

export interface MigrationPolicy {
  allowCredentialReuse: boolean;
  includeAssociatedData: boolean;
}

export interface MigrationPlanUser {
  source: {
    sourceSystem: "dooragent";
    sourceType: "user";
    sourceId: string;
    sourceDigest: string;
  };
  decision: "create" | "merge" | "reject";
  targetUserId: string | null;
  credential: CredentialImportDecision;
  candidateDigest: string;
  credentialSync: MigrationPlanCredentialSync | null;
  reasonCode: string | null;
}

export interface MigrationPlanCredentialSync {
  source: {
    sourceSystem: "dooragent";
    sourceType: "credential";
    sourceId: string;
    sourceDigest: string;
  };
  targetUserId: string;
  expectedRole: DoorAgentRole;
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  credentialDigest: string;
  rollbackSnapshotRef: string;
}

export interface MigrationPlanWorkspace {
  source: {
    sourceSystem: "dooragent";
    sourceType: "workspace";
    sourceId: string;
    sourceDigest: string;
  };
  decision: "migrate" | "reject";
  targetUserId: string | null;
  aggregate: WorkspaceAggregate | null;
  candidateDigest: string;
  reasonCode: string | null;
}

export interface WorkspaceRollbackJournal {
  source: MigrationPlanWorkspace["source"];
  targetUserId: string;
  targetWorkspaceId: string;
  role: DoorAgentRole;
  aggregate: WorkspaceAggregate;
  result: "migrated" | "merged";
  createdTarget: boolean;
  cutoverEpochId: string;
}

export interface MigrationPlan {
  version: 1;
  sourceSystem: "dooragent";
  snapshotDigest: string;
  inventoryDigest: string;
  policy: MigrationPolicy;
  policyDigest: string;
  users: MigrationPlanUser[];
  workspaces: MigrationPlanWorkspace[];
  planDigest: string;
  planId: string;
  runId: string;
}

export interface MigrationReportUser {
  source: MigrationPlanUser["source"];
  targetUserId: string | null;
  result: "migrated" | "merged" | "rejected" | "reset_required";
  reasonCode: string | null;
}

export interface MigrationReportWorkspace {
  source: MigrationPlanWorkspace["source"];
  targetUserId: string | null;
  targetWorkspaceId: string | null;
  result: "migrated" | "merged" | "rejected";
  reasonCode: string | null;
}

export interface MigrationUserResultEvent extends MigrationReportUser {
  eventId: string;
  runId: string;
  planId: string;
  cutoverEpochId: string;
  snapshotDigest: string;
  sequence: number;
  occurredAt: string;
  ignorable: false;
}

export interface MigrationObjectResultEvent {
  eventId: string;
  runId: string;
  planId: string;
  cutoverEpochId: string;
  snapshotDigest: string;
  sequence: number;
  occurredAt: string;
  ignorable: false;
  source: MigrationPlanWorkspace["source"];
  targetUserId: string | null;
  targetResourceId: string | null;
  result: "claimed" | "unchanged" | "rejected";
  reasonCode: string | null;
}

export interface MigrationReportCounts {
  total: number;
  migrated: number;
  merged: number;
  rejected: number;
  resetRequired: number;
}

export interface MigrationWorkspaceReportCounts {
  total: number;
  migrated: number;
  merged: number;
  rejected: number;
}

export interface MigrationReport {
  mode: "dry-run" | "apply";
  status: "ready" | "blocked" | "complete" | "partial";
  runId: string;
  planId: string;
  planDigest: string;
  snapshotDigest: string;
  counts: MigrationReportCounts;
  users: MigrationReportUser[];
  workspaceCounts: MigrationWorkspaceReportCounts;
  workspaces: MigrationReportWorkspace[];
  reportDigest: string;
}

export interface MigrationApproval {
  approvalRef: string;
  cutoverEpochId: string;
}

export interface MigrationCredentialSyncReport {
  runId: string;
  planId: string;
  snapshotDigest: string;
  eligible: number;
  processed: number;
  alreadyProcessed: number;
  revokedSessionCount: number;
  status: "complete";
  reportDigest: string;
}

export interface ReconciliationReport {
  runId: string;
  planId: string;
  snapshotDigest: string;
  matched: number;
  missing: number;
  mismatched: number;
  result: "matched" | "mismatch";
  reportDigest: string;
}

export interface MigrationRollbackWorkspace {
  source: MigrationPlanWorkspace["source"];
  targetUserId: string;
  targetWorkspaceId: string;
  result: "rolled-back" | "retained" | "rejected";
  reasonCode: string | null;
}

export interface MigrationRollbackWorkspaceCounts {
  total: number;
  rolledBack: number;
  retained: number;
  rejected: number;
}

export interface RollbackReport {
  runId: string;
  planId: string;
  snapshotDigest: string;
  rolledBack: number;
  retained: number;
  rejected: number;
  reasonCode: string | null;
  result: "complete" | "partial" | "rejected";
  workspaceCounts: MigrationRollbackWorkspaceCounts;
  workspaces: MigrationRollbackWorkspace[];
  reportDigest: string;
}

export interface DoorAgentMigrationService {
  inspect(source: FrozenDoorAgentSource, signal?: AbortSignal): Promise<MigrationInventory>;
  plan(inventory: MigrationInventory, policy: MigrationPolicy, signal?: AbortSignal): Promise<MigrationPlan>;
  dryRun(plan: MigrationPlan, signal?: AbortSignal): Promise<MigrationReport>;
  issueApplyApproval(
    plan: MigrationPlan,
    cutoverEpochId: string,
    signal?: AbortSignal,
  ): Promise<MigrationApproval>;
  issueRollbackApproval(runId: string, signal?: AbortSignal): Promise<MigrationApproval>;
  apply(plan: MigrationPlan, approval: MigrationApproval, signal?: AbortSignal): Promise<MigrationReport>;
  syncCredentials(
    runId: string,
    source: FrozenDoorAgentSource,
    signal?: AbortSignal,
  ): Promise<MigrationCredentialSyncReport>;
  reconcile(runId: string, signal?: AbortSignal): Promise<ReconciliationReport>;
  rollback(runId: string, approval: MigrationApproval, signal?: AbortSignal): Promise<RollbackReport>;
}


import type {
  AuthOperator,
  CredentialImportDecision,
} from "dsh-lark-auth";
import type { Scope } from "dsh-lark-contracts";
