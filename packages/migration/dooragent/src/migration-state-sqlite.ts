import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import { openMigrationStateDatabase } from "./migration-state-database.js";
import {
  assertEpoch,
  assertReportBinding,
  assertReusablePlan,
  assertRollbackBinding,
  invalid,
  isPhase,
  isRecord,
  migrationActorDigest,
  nullableText,
  parseJson,
  parseNullableJson,
  positiveSequence,
  safeJson,
  sequence,
  text,
  validateDigest,
  validateLeaseGuard,
  validateLeaseWindow,
  validateRunLease,
  validateSequence,
  validateSourceUserId,
} from "./migration-state-shared.js";
import type {
  MigrationRunLease,
  MigrationRunLeaseGuard,
  MigrationRunStore,
  StoredMigrationRun,
} from "./migration-state.js";
import {
  loadSqliteObjectResultReceipt,
  loadSqliteUserResultReceipt,
  saveSqliteObjectResultReceipt,
  saveSqliteUserResultReceipt,
  type StoredMigrationObjectResultReceipt,
  type StoredMigrationUserResultReceipt,
} from "./migration-user-result-receipt.js";
import type {
  FrozenDoorAgentSource,
  MigrationActor,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationReport,
  MigrationUserResultEvent,
  RollbackReport,
  WorkspaceRollbackJournal,
} from "./types.js";

export class SqliteMigrationRunStore implements MigrationRunStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    this.database = openMigrationStateDatabase(path);
  }

  loadPlan(stateKey: string): StoredMigrationRun | undefined {
    return this.load("state_key", stateKey);
  }

  loadRun(runId: string): StoredMigrationRun | undefined {
    return this.load("run_id", runId);
  }

  savePlan(
    stateKey: string,
    actor: MigrationActor,
    source: FrozenDoorAgentSource,
    plan: MigrationPlan,
  ): StoredMigrationRun {
    validateDigest(stateKey);
    const actorDigest = migrationActorDigest(actor);
    validateDigest(actorDigest);
    validateDigest(plan.runId);
    const sourceJson = safeJson(source);
    const planJson = safeJson(plan);
    const existingByKey = this.loadPlan(stateKey);
    if (existingByKey) {
      assertReusablePlan(existingByKey, stateKey, actor, source, plan);
      return existingByKey;
    }
    const existingByRun = this.loadRun(plan.runId);
    if (existingByRun) {
      assertReusablePlan(existingByRun, stateKey, actor, source, plan);
      return existingByRun;
    }
    this.database.prepare(`
      INSERT INTO migration_runs
        (state_key, run_id, actor_digest, source_json, plan_json, phase)
      VALUES (?, ?, ?, ?, ?, 'planned')
    `).run(stateKey, plan.runId, actorDigest, sourceJson, planJson);
    const stored = this.loadPlan(stateKey);
    if (!stored) invalid();
    return stored;
  }

  markAuthorized(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    validateLeaseGuard(guard);
    assertEpoch(this.required(runId).cutoverEpochId, cutoverEpochId);
    const result = this.database.prepare(`
      UPDATE migration_runs
      SET phase = CASE WHEN phase = 'planned' THEN 'authorized' ELSE phase END,
          cutover_epoch_id = COALESCE(cutover_epoch_id, ?)
      WHERE run_id = ? AND (cutover_epoch_id IS NULL OR cutover_epoch_id = ?)
        AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(cutoverEpochId, runId, cutoverEpochId, guard.owner, guard.fence, guard.nowMs);
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  bindCutoverEpoch(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    validateLeaseGuard(guard);
    assertEpoch(this.required(runId).cutoverEpochId, cutoverEpochId);
    const result = this.database.prepare(`
      UPDATE migration_runs SET cutover_epoch_id = COALESCE(cutover_epoch_id, ?)
      WHERE run_id = ? AND phase = 'planned'
        AND (cutover_epoch_id IS NULL OR cutover_epoch_id = ?)
        AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(cutoverEpochId, runId, cutoverEpochId, guard.owner, guard.fence, guard.nowMs);
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  saveReport(
    runId: string,
    report: MigrationReport,
    guard: MigrationRunLeaseGuard,
    workspaceRollback?: WorkspaceRollbackJournal[],
  ): StoredMigrationRun {
    validateLeaseGuard(guard);
    const state = this.required(runId);
    assertReportBinding(state, report);
    const json = safeJson(report);
    const workspaceRollbackJson = workspaceRollback === undefined ? undefined : safeJson(workspaceRollback);
    const credentialSyncJson = safeJson(state.credentialSyncedSourceIds);
    if (state.workspaceRollback && workspaceRollback
      && canonicalJson(state.workspaceRollback) !== canonicalJson(workspaceRollback)) invalid();
    const result = this.database.prepare(`
      UPDATE migration_runs SET phase = 'complete', report_json = COALESCE(report_json, ?),
        workspace_rollback_json = COALESCE(workspace_rollback_json, ?),
        credential_sync_json = COALESCE(credential_sync_json, ?)
      WHERE run_id = ? AND phase IN ('authorized', 'complete')
        AND (report_json IS NULL OR report_json = ?)
        AND (workspace_rollback_json IS NULL OR workspace_rollback_json = ?)
        AND (credential_sync_json IS NULL OR credential_sync_json = ?)
        AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(
      json,
      workspaceRollbackJson ?? null,
      credentialSyncJson,
      runId,
      json,
      workspaceRollbackJson ?? null,
      credentialSyncJson,
      guard.owner,
      guard.fence,
      guard.nowMs,
    );
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  saveRollback(runId: string, rollback: RollbackReport, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    validateLeaseGuard(guard);
    const state = this.required(runId);
    assertRollbackBinding(state, rollback);
    const json = safeJson(rollback);
    const result = this.database.prepare(`
      UPDATE migration_runs SET phase = 'rolled-back', rollback_json = COALESCE(rollback_json, ?)
      WHERE run_id = ? AND phase IN ('authorized', 'complete', 'rolled-back')
        AND (rollback_json IS NULL OR rollback_json = ?)
        AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(json, runId, json, guard.owner, guard.fence, guard.nowMs);
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  saveUserResultReceipt(
    event: MigrationUserResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationUserResultReceipt {
    return saveSqliteUserResultReceipt(this.database, event, guard);
  }

  loadUserResultReceipt(eventId: string): StoredMigrationUserResultReceipt | undefined {
    return loadSqliteUserResultReceipt(this.database, eventId);
  }

  saveObjectResultReceipt(
    event: MigrationObjectResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationObjectResultReceipt {
    return saveSqliteObjectResultReceipt(this.database, event, guard);
  }

  loadObjectResultReceipt(eventId: string): StoredMigrationObjectResultReceipt | undefined {
    return loadSqliteObjectResultReceipt(this.database, eventId);
  }

  markCredentialSynced(
    runId: string,
    sourceUserId: string,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationRun {
    validateSourceUserId(sourceUserId);
    validateLeaseGuard(guard);
    const state = this.required(runId);
    if (state.phase !== "authorized" && state.phase !== "complete") invalid();
    const currentJson = safeJson(state.credentialSyncedSourceIds);
    const synced = [...state.credentialSyncedSourceIds];
    if (!synced.includes(sourceUserId)) synced.push(sourceUserId);
    synced.sort();
    const nextJson = safeJson(synced);
    const result = this.database.prepare(`
      UPDATE migration_runs
      SET credential_sync_json = ?
      WHERE run_id = ? AND phase IN ('authorized', 'complete')
        AND (credential_sync_json IS NULL OR credential_sync_json = ?)
        AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(nextJson, runId, currentJson, guard.owner, guard.fence, guard.nowMs);
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  markOutboxAcked(
    runId: string,
    sequence: number,
    guard: MigrationRunLeaseGuard,
    receiptKind: "user" | "object" | false = "user",
  ): StoredMigrationRun {
    validateSequence(sequence);
    validateLeaseGuard(guard);
    const receiptTable = receiptKind === "user"
      ? "migration_user_result_receipts"
      : receiptKind === "object"
        ? "migration_object_result_receipts"
        : null;
    const result = receiptTable === null
      ? this.database.prepare(`
        UPDATE migration_runs SET outbox_acked_sequence = MAX(outbox_acked_sequence, ?)
        WHERE run_id = ? AND phase = 'complete' AND ? <= outbox_acked_sequence + 1
          AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
      `).run(sequence, runId, sequence, guard.owner, guard.fence, guard.nowMs)
      : this.database.prepare(`
        UPDATE migration_runs SET outbox_acked_sequence = MAX(outbox_acked_sequence, ?)
        WHERE run_id = ? AND phase = 'complete' AND ? <= outbox_acked_sequence + 1
          AND EXISTS (
            SELECT 1 FROM ${receiptTable} receipt
            WHERE receipt.run_id = migration_runs.run_id AND receipt.sequence = ?
          )
          AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
      `).run(sequence, runId, sequence, sequence, guard.owner, guard.fence, guard.nowMs);
    if (Number(result.changes) !== 1) invalid();
    return this.required(runId);
  }

  claimRun(
    runId: string,
    owner: string,
    nowMs: number,
    leaseUntilMs: number,
  ): MigrationRunLease | undefined {
    validateLeaseWindow(owner, nowMs, leaseUntilMs);
    const row = this.database.prepare(`
      UPDATE migration_runs
      SET lease_owner = ?, lease_expires_at = ?, lease_fence = lease_fence + 1
      WHERE run_id = ? AND (lease_owner IS NULL OR lease_expires_at <= ?)
      RETURNING lease_fence
    `).get(owner, leaseUntilMs, runId, nowMs) as { lease_fence?: unknown } | undefined;
    if (!row) return undefined;
    const fence = positiveSequence(row.lease_fence);
    return { owner, fence };
  }

  renewRun(runId: string, lease: MigrationRunLease, nowMs: number, leaseUntilMs: number): boolean {
    validateRunLease(lease);
    validateLeaseWindow(lease.owner, nowMs, leaseUntilMs);
    const result = this.database.prepare(`
      UPDATE migration_runs SET lease_expires_at = ?
      WHERE run_id = ? AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(leaseUntilMs, runId, lease.owner, lease.fence, nowMs);
    return Number(result.changes) === 1;
  }

  releaseRun(runId: string, lease: MigrationRunLeaseGuard): void {
    validateLeaseGuard(lease);
    this.database.prepare(`
      UPDATE migration_runs SET lease_owner = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
    `).run(runId, lease.owner, lease.fence, lease.nowMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private load(column: "state_key" | "run_id", value: string): StoredMigrationRun | undefined {
    validateDigest(value);
    const row = this.database.prepare(`
      SELECT state_key, run_id, actor_digest, source_json, plan_json, phase,
             cutover_epoch_id, report_json, rollback_json, workspace_rollback_json,
             credential_sync_json,
             outbox_acked_sequence
      FROM migration_runs WHERE ${column} = ?
    `).get(value);
    return row === undefined ? undefined : parseRow(row);
  }

  private required(runId: string): StoredMigrationRun {
    const state = this.loadRun(runId);
    if (!state) invalid();
    return state;
  }
}

function parseRow(value: unknown): StoredMigrationRun {
  if (!isRecord(value)) invalid();
  const stateKey = text(value.state_key);
  const runId = text(value.run_id);
  const actorDigest = text(value.actor_digest);
  validateDigest(stateKey);
  validateDigest(runId);
  validateDigest(actorDigest);
  const source = parseJson<FrozenDoorAgentSource>(value.source_json);
  const plan = parseJson<MigrationPlan>(value.plan_json);
  if (plan.runId !== runId || !isPhase(value.phase)) invalid();
  return {
    stateKey,
    actorDigest,
    source,
    plan,
    phase: value.phase,
    cutoverEpochId: nullableText(value.cutover_epoch_id),
    report: parseNullableJson<MigrationReport>(value.report_json),
    rollback: parseNullableJson<RollbackReport>(value.rollback_json),
    workspaceRollback: parseNullableJson<WorkspaceRollbackJournal[]>(value.workspace_rollback_json, true),
    credentialSyncedSourceIds: parseCredentialSyncList(value.credential_sync_json),
    outboxAckedSequence: sequence(value.outbox_acked_sequence),
  };
}

function parseCredentialSyncList(value: unknown): string[] {
  const parsed = parseNullableJson<string[]>(value, true);
  if (parsed === null) return [];
  if (!Array.isArray(parsed)) invalid();
  const unique = [...new Set(parsed)];
  if (unique.length !== parsed.length) invalid();
  for (const sourceUserId of unique) validateSourceUserId(sourceUserId);
  return unique.sort();
}
