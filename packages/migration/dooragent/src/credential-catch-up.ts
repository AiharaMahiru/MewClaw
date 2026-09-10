import type { AuthCapability, AuthImportContext } from "dsh-lark-auth";

import { digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import { buildCredentialSyncCandidate } from "./planner.js";
import type {
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationCredentialSyncReport,
  MigrationPlan,
  MigrationReport,
} from "./types.js";

export interface CredentialCatchUpInput {
  auth: AuthCapability;
  actor: MigrationActor;
  plan: MigrationPlan;
  report: MigrationReport;
  loaded: LoadedDoorAgentSource;
  cutoverEpochId: string;
  syncedSourceIds: ReadonlySet<string>;
  markSynced(sourceId: string): void;
  renewLease(): void;
  signal?: AbortSignal;
}

export async function catchUpCredentials(
  input: CredentialCatchUpInput,
): Promise<MigrationCredentialSyncReport> {
  const records = new Map(input.loaded.records.map((record) => [record.sourceId, record]));
  const targets = new Map(input.report.users.map((result) => [result.source.sourceId, result]));
  let eligible = 0;
  let processed = 0;
  let alreadyProcessed = 0;
  let revokedSessionCount = 0;
  for (const planned of input.plan.users) {
    if (planned.decision === "reject" || planned.credential.action !== "reuse") continue;
    const applied = targets.get(planned.source.sourceId);
    if (!applied?.targetUserId || (applied.result !== "migrated" && applied.result !== "merged")) {
      planInvalid();
    }
    eligible += 1;
    if (input.syncedSourceIds.has(planned.source.sourceId)) {
      alreadyProcessed += 1;
      continue;
    }
    const record = records.get(planned.source.sourceId);
    if (!record || record.sourceDigest !== planned.source.sourceDigest) planInvalid();
    const sync = buildCredentialSyncCandidate(record, applied.targetUserId, input.plan.snapshotDigest);
    input.renewLease();
    throwIfAborted(input.signal);
    const result = await syncOne(input, record.passwordEncoded, sync);
    processed += 1;
    revokedSessionCount += result.revokedSessionCount;
    input.markSynced(record.sourceId);
  }
  const body = {
    runId: input.plan.runId,
    planId: input.plan.planId,
    snapshotDigest: input.plan.snapshotDigest,
    eligible,
    processed,
    alreadyProcessed,
    revokedSessionCount,
    status: "complete" as const,
  };
  return { ...body, reportDigest: digestCanonical(body) };
}

async function syncOne(
  input: CredentialCatchUpInput,
  sourceCredential: string,
  sync: ReturnType<typeof buildCredentialSyncCandidate>,
) {
  const context: AuthImportContext = {
    ...input.actor,
    runId: input.plan.runId,
    planId: input.plan.planId,
    snapshotDigest: input.plan.snapshotDigest,
    source: sync.source,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const approval = await input.auth.issueImportApproval({
    ...context,
    cutoverEpochId: input.cutoverEpochId,
    operation: "sync-credential",
    targetUserId: sync.targetUserId,
    expectedRole: sync.expectedRole,
    expectedDefaultMode: sync.expectedDefaultMode,
    expectedStatus: sync.expectedStatus,
    credentialDigest: sync.credentialDigest,
    rollbackSnapshotRef: sync.rollbackSnapshotRef,
  });
  try {
    input.renewLease();
    throwIfAborted(input.signal);
    return await input.auth.syncCredential({
      ...context,
      approvalRef: approval.approvalRef,
      cutoverEpochId: input.cutoverEpochId,
      targetUserId: sync.targetUserId,
      expectedRole: sync.expectedRole,
      expectedDefaultMode: sync.expectedDefaultMode,
      expectedStatus: sync.expectedStatus,
      sourceCredential,
      credentialDigest: sync.credentialDigest,
      rollbackSnapshotRef: sync.rollbackSnapshotRef,
    });
  } catch (error) {
    await revokeApproval(input.auth, context, approval.approvalRef);
    throw error;
  }
}

async function revokeApproval(
  auth: AuthCapability,
  context: AuthImportContext,
  approvalRef: string,
): Promise<void> {
  try {
    await auth.revokeImportApproval({ ...context, approvalRef });
  } catch {
    // 原错误优先；批准仍受一次性消费和 TTL 限制。
  }
}

function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
