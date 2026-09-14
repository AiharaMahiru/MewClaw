import type { AuthCapability } from "dsh-lark-auth";

import { digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import type { MigrationRunLeaseGuard, StoredMigrationRun } from "./migration-state.js";
import {
  planInvalid,
  sanitizeReason,
  validateCounts,
} from "./service-helpers.js";
import { buildUserActionManifest } from "./user-action-runner.js";
import type { executeUserActionRun } from "./user-action-runner.js";
import type {
  LoadedDoorAgentSource,
  MigrationPlan,
  MigrationReport,
  MigrationReportCounts,
  MigrationReportUser,
  MigrationReportWorkspace,
  MigrationRollbackWorkspace,
  MigrationWorkspaceReportCounts,
  RollbackReport,
  WorkspaceRollbackJournal,
} from "./types.js";
import type { WorkspaceMigrationProvider } from "./workspace-provider.js";

export function buildApplyReport(
  plan: MigrationPlan,
  users: MigrationReportUser[],
  workspaces: MigrationReportWorkspace[],
): MigrationReport {
  const counts = countResults(users);
  const workspaceCounts = countWorkspaceResults(workspaces);
  const body = {
    mode: "apply" as const,
    status: counts.rejected > 0 || workspaceCounts.rejected > 0
      ? "partial" as const : "complete" as const,
    runId: plan.runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    snapshotDigest: plan.snapshotDigest,
    counts,
    users,
    workspaceCounts,
    workspaces,
  };
  return { ...body, reportDigest: digestCanonical(body) };
}

function countWorkspaceResults(users: MigrationReportWorkspace[]): MigrationWorkspaceReportCounts {
  const counts = { total: users.length, migrated: 0, merged: 0, rejected: 0 };
  for (const user of users) counts[user.result] += 1;
  return counts;
}

function countResults(users: MigrationReportUser[]): MigrationReportCounts {
  const counts = { total: users.length, migrated: 0, merged: 0, rejected: 0, resetRequired: 0 };
  for (const user of users) {
    if (user.result === "migrated") counts.migrated += 1;
    else if (user.result === "merged") counts.merged += 1;
    else if (user.result === "rejected") counts.rejected += 1;
    else counts.resetRequired += 1;
  }
  return counts;
}

export function buildRollbackReport(
  plan: MigrationPlan,
  value: Awaited<ReturnType<AuthCapability["rollbackImport"]>>,
  workspaces: MigrationRollbackWorkspace[],
  reasonCode = value.reasonCode,
): RollbackReport {
  const workspaceCounts = countRollbackWorkspaces(workspaces);
  const rolledBack = value.rolledBack + workspaceCounts.rolledBack;
  const retained = value.retained + workspaceCounts.retained;
  const rejected = value.rejected + workspaceCounts.rejected;
  validateCounts(rolledBack, retained, rejected);
  const result = rejected === 0 ? "complete" as const
    : rolledBack === 0 ? "rejected" as const : "partial" as const;
  const body = {
    runId: plan.runId,
    planId: plan.planId,
    snapshotDigest: plan.snapshotDigest,
    rolledBack,
    retained,
    rejected,
    reasonCode: sanitizeReason(reasonCode),
    result,
    workspaceCounts,
    workspaces,
  };
  return { ...body, reportDigest: digestCanonical(body) };
}

export function buildWorkspaceRollbackJournal(
  plan: MigrationPlan,
  loaded: LoadedDoorAgentSource,
  workspaces: MigrationReportWorkspace[],
  outbox: Awaited<ReturnType<typeof executeUserActionRun>>["outbox"],
  cutoverEpochId: string,
): WorkspaceRollbackJournal[] {
  const definitions = new Map(buildUserActionManifest(plan).map((action) => [action.source.sourceId, action]));
  const migrated = workspaces.filter(
    (workspace): workspace is MigrationReportWorkspace & { result: "migrated" | "merged" } =>
      workspace.result !== "rejected",
  );
  return migrated.map((workspace) => {
    const record = loaded.workspaces?.find((candidate) => candidate.sourceUserId === workspace.source.sourceId);
    const user = loaded.records.find((candidate) => candidate.sourceId === workspace.source.sourceId);
    const action = definitions.get(workspace.source.sourceId);
    const event = action && outbox.find((candidate) => candidate.actionId === action.actionId);
    if (!record?.aggregate || !user || !action || !event || event.result.operation !== "claim-resource"
      || !workspace.targetUserId || !workspace.targetWorkspaceId
      || event.result.targetUserId !== workspace.targetUserId
      || event.result.targetResourceId !== workspace.targetWorkspaceId) planInvalid();
    return {
      source: workspace.source,
      targetUserId: workspace.targetUserId,
      targetWorkspaceId: workspace.targetWorkspaceId,
      role: user.role,
      aggregate: record.aggregate,
      result: workspace.result,
      createdTarget: workspace.result === "migrated" && event.result.result === "claimed",
      cutoverEpochId,
    };
  });
}

export async function rollbackWorkspaces(
  entry: { state: StoredMigrationRun; loaded: LoadedDoorAgentSource },
  provider: WorkspaceMigrationProvider | undefined,
  cutoverEpochId: string,
  signal: AbortSignal,
  checkpoint: () => MigrationRunLeaseGuard,
): Promise<MigrationRollbackWorkspace[]> {
  const journal = entry.state.workspaceRollback;
  if (!journal || journal.length === 0) return [];
  if (!provider) return journal.map((item) => rejectedWorkspaceRollback(item, "ROLLBACK_GUARD_UNAVAILABLE"));
  const records = new Map((entry.loaded.workspaces ?? []).map((record) => [record.sourceUserId, record]));
  const results: MigrationRollbackWorkspace[] = [];
  for (const item of journal) {
    checkpoint();
    throwIfAborted(signal);
    const record = records.get(item.source.sourceId);
    if (!record?.aggregate) {
      results.push(rejectedWorkspaceRollback(item, "ROLLBACK_SOURCE_UNAVAILABLE"));
      continue;
    }
    try {
      const result = await provider.rollback({
        sourcePath: record.workspaceRoot,
        targetUserId: item.targetUserId,
        role: item.role,
        aggregate: item.aggregate,
        targetWorkspaceId: item.targetWorkspaceId,
        result: item.result,
        createdTarget: item.createdTarget,
        cutoverEpochId,
        expectedCutoverEpochId: item.cutoverEpochId,
        signal,
      });
      results.push({
        source: item.source,
        targetUserId: item.targetUserId,
        targetWorkspaceId: item.targetWorkspaceId,
        result: result.result,
        reasonCode: result.reasonCode,
      });
    } catch (error) {
      if (error instanceof DoorAgentMigrationError && error.code === "IMPORT_ABORTED") throw error;
      results.push(rejectedWorkspaceRollback(item, "ROLLBACK_PROVIDER_FAILED"));
    }
  }
  return results;
}

function rejectedWorkspaceRollback(
  item: WorkspaceRollbackJournal,
  reasonCode: string,
): MigrationRollbackWorkspace {
  return {
    source: item.source,
    targetUserId: item.targetUserId,
    targetWorkspaceId: item.targetWorkspaceId,
    result: "rejected",
    reasonCode,
  };
}

export function retainedWorkspaceResults(
  journal: WorkspaceRollbackJournal[] | null,
  reasonCode: string | null,
): MigrationRollbackWorkspace[] {
  return (journal ?? []).map((item) => ({
    source: item.source,
    targetUserId: item.targetUserId,
    targetWorkspaceId: item.targetWorkspaceId,
    result: "retained" as const,
    reasonCode: reasonCode ?? "AUTH_ROLLBACK_REJECTED",
  }));
}

function countRollbackWorkspaces(
  workspaces: MigrationRollbackWorkspace[],
): { total: number; rolledBack: number; retained: number; rejected: number } {
  const counts = { total: workspaces.length, rolledBack: 0, retained: 0, rejected: 0 };
  for (const workspace of workspaces) {
    if (workspace.result === "rolled-back") counts.rolledBack += 1;
    else if (workspace.result === "retained") counts.retained += 1;
    else counts.rejected += 1;
  }
  return counts;
}
