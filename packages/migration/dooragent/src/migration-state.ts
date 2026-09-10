import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import { openMigrationStateDatabase } from "./migration-state-database.js";
import {
  loadSqliteObjectResultReceipt,
  loadSqliteUserResultReceipt,
  MemoryMigrationObjectResultReceipts,
  MemoryMigrationUserResultReceipts,
  saveSqliteObjectResultReceipt,
  saveSqliteUserResultReceipt,
  type StoredMigrationObjectResultReceipt,
  type StoredMigrationUserResultReceipt,
} from "./migration-user-result-receipt.js";
import type {
  FrozenDoorAgentSource,
  MigrationActor,
  MigrationInventory,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationPolicy,
  MigrationReport,
  MigrationUserResultEvent,
  RollbackReport,
  WorkspaceRollbackJournal,
} from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 4_194_304;

export type MigrationRunPhase = "planned" | "authorized" | "complete" | "rolled-back";

export interface StoredMigrationRun {
  stateKey: string;
  actorDigest: string;
  source: FrozenDoorAgentSource;
  plan: MigrationPlan;
  phase: MigrationRunPhase;
  cutoverEpochId: string | null;
  report: MigrationReport | null;
  rollback: RollbackReport | null;
  workspaceRollback: WorkspaceRollbackJournal[] | null;
  credentialSyncedSourceIds: string[];
  outboxAckedSequence: number;
}

export interface MigrationRunLease {
  owner: string;
  fence: number;
}

export interface MigrationRunLeaseGuard extends MigrationRunLease {
  nowMs: number;
}

export interface MigrationRunStore {
  loadPlan(stateKey: string): StoredMigrationRun | undefined;
  loadRun(runId: string): StoredMigrationRun | undefined;
  savePlan(
    stateKey: string,
    actor: MigrationActor,
    source: FrozenDoorAgentSource,
    plan: MigrationPlan,
  ): StoredMigrationRun;
  bindCutoverEpoch(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun;
  markAuthorized(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun;
  saveReport(
    runId: string,
    report: MigrationReport,
    guard: MigrationRunLeaseGuard,
    workspaceRollback?: WorkspaceRollbackJournal[],
  ): StoredMigrationRun;
  saveRollback(runId: string, rollback: RollbackReport, guard: MigrationRunLeaseGuard): StoredMigrationRun;
  saveUserResultReceipt(
    event: MigrationUserResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationUserResultReceipt;
  loadUserResultReceipt(eventId: string): StoredMigrationUserResultReceipt | undefined;
  saveObjectResultReceipt(
    event: MigrationObjectResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationObjectResultReceipt;
  loadObjectResultReceipt(eventId: string): StoredMigrationObjectResultReceipt | undefined;
  markCredentialSynced(
    runId: string,
    sourceUserId: string,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationRun;
  markOutboxAcked(
    runId: string,
    sequence: number,
    guard: MigrationRunLeaseGuard,
    receiptKind?: "user" | "object" | false,
  ): StoredMigrationRun;
  claimRun(
    runId: string,
    owner: string,
    nowMs: number,
    leaseUntilMs: number,
  ): MigrationRunLease | undefined;
  renewRun(runId: string, lease: MigrationRunLease, nowMs: number, leaseUntilMs: number): boolean;
  releaseRun(runId: string, guard: MigrationRunLeaseGuard): void;
  close(): void;
}

export class MemoryMigrationRunStore implements MigrationRunStore {
  private readonly byKey = new Map<string, StoredMigrationRun>();
  private readonly fences = new Map<string, number>();
  private readonly leases = new Map<string, MigrationRunLease & { expiresAt: number }>();
  private readonly receipts = new MemoryMigrationUserResultReceipts();
  private readonly objectReceipts = new MemoryMigrationObjectResultReceipts();

  loadPlan(stateKey: string): StoredMigrationRun | undefined {
    return clone(this.byKey.get(stateKey));
  }

  loadRun(runId: string): StoredMigrationRun | undefined {
    return clone([...this.byKey.values()].find((state) => state.plan.runId === runId));
  }

  savePlan(
    stateKey: string,
    actor: MigrationActor,
    source: FrozenDoorAgentSource,
    plan: MigrationPlan,
  ): StoredMigrationRun {
    const existing = this.byKey.get(stateKey);
    if (existing) return clone(existing)!;
    const existingRun = [...this.byKey.values()].find((state) => state.plan.runId === plan.runId);
    if (existingRun) {
      assertReusablePlan(existingRun, stateKey, actor, source, plan);
      return clone(existingRun)!;
    }
    const state = plannedState(stateKey, actor, source, plan);
    this.byKey.set(stateKey, state);
    return clone(state)!;
  }

  markAuthorized(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    this.assertLease(runId, guard);
    const state = this.required(runId);
    assertEpoch(state.cutoverEpochId, cutoverEpochId);
    state.cutoverEpochId = cutoverEpochId;
    if (state.phase === "planned") state.phase = "authorized";
    return clone(state)!;
  }

  bindCutoverEpoch(runId: string, cutoverEpochId: string, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    this.assertLease(runId, guard);
    const state = this.required(runId);
    if (state.phase !== "planned") invalid();
    assertEpoch(state.cutoverEpochId, cutoverEpochId);
    state.cutoverEpochId = cutoverEpochId;
    return clone(state)!;
  }

  saveReport(
    runId: string,
    report: MigrationReport,
    guard: MigrationRunLeaseGuard,
    workspaceRollback?: WorkspaceRollbackJournal[],
  ): StoredMigrationRun {
    this.assertLease(runId, guard);
    const state = this.required(runId);
    if (state.phase !== "authorized" && state.phase !== "complete") invalid();
    assertReportBinding(state, report);
    if (state.report && canonicalJson(state.report) !== canonicalJson(report)) invalid();
    if (state.workspaceRollback && workspaceRollback
      && canonicalJson(state.workspaceRollback) !== canonicalJson(workspaceRollback)) invalid();
    state.report = structuredClone(report);
    if (workspaceRollback) state.workspaceRollback = structuredClone(workspaceRollback);
    state.phase = "complete";
    return clone(state)!;
  }

  saveRollback(runId: string, rollback: RollbackReport, guard: MigrationRunLeaseGuard): StoredMigrationRun {
    this.assertLease(runId, guard);
    const state = this.required(runId);
    if (state.phase !== "authorized" && state.phase !== "complete"
      && state.phase !== "rolled-back") invalid();
    assertRollbackBinding(state, rollback);
    if (state.rollback && canonicalJson(state.rollback) !== canonicalJson(rollback)) invalid();
    state.rollback = structuredClone(rollback);
    state.phase = "rolled-back";
    return clone(state)!;
  }

  saveUserResultReceipt(
    event: MigrationUserResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationUserResultReceipt {
    this.assertLease(event.runId, guard);
    return this.receipts.save(event, this.required(event.runId), guard.nowMs);
  }

  loadUserResultReceipt(eventId: string): StoredMigrationUserResultReceipt | undefined {
    return this.receipts.load(eventId);
  }

  saveObjectResultReceipt(
    event: MigrationObjectResultEvent,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationObjectResultReceipt {
    this.assertLease(event.runId, guard);
    return this.objectReceipts.save(event, this.required(event.runId), guard.nowMs);
  }

  loadObjectResultReceipt(eventId: string): StoredMigrationObjectResultReceipt | undefined {
    return this.objectReceipts.load(eventId);
  }

  markCredentialSynced(
    runId: string,
    sourceUserId: string,
    guard: MigrationRunLeaseGuard,
  ): StoredMigrationRun {
    this.assertLease(runId, guard);
    validateSourceUserId(sourceUserId);
    const state = this.required(runId);
    if (state.phase !== "authorized" && state.phase !== "complete") invalid();
    if (!state.credentialSyncedSourceIds.includes(sourceUserId)) {
      state.credentialSyncedSourceIds.push(sourceUserId);
      state.credentialSyncedSourceIds.sort();
    }
    return clone(state)!;
  }

  markOutboxAcked(
    runId: string,
    sequence: number,
    guard: MigrationRunLeaseGuard,
    receiptKind: "user" | "object" | false = "user",
  ): StoredMigrationRun {
    this.assertLease(runId, guard);
    const state = this.required(runId);
    validateSequence(sequence);
    if (state.phase !== "complete" || sequence > state.outboxAckedSequence + 1
      || receiptKind === "user" && !this.receipts.has(runId, sequence)
      || receiptKind === "object" && !this.objectReceipts.has(runId, sequence)) invalid();
    state.outboxAckedSequence = Math.max(state.outboxAckedSequence, sequence);
    return clone(state)!;
  }

  claimRun(
    runId: string,
    owner: string,
    nowMs: number,
    leaseUntilMs: number,
  ): MigrationRunLease | undefined {
    this.required(runId);
    validateLeaseWindow(owner, nowMs, leaseUntilMs);
    const lease = this.leases.get(runId);
    if (lease && lease.expiresAt > nowMs) return undefined;
    const fence = (this.fences.get(runId) ?? 0) + 1;
    const claimed = { owner, fence, expiresAt: leaseUntilMs };
    this.fences.set(runId, fence);
    this.leases.set(runId, claimed);
    return { owner, fence };
  }

  renewRun(runId: string, requested: MigrationRunLease, nowMs: number, leaseUntilMs: number): boolean {
    validateRunLease(requested);
    validateLeaseWindow(requested.owner, nowMs, leaseUntilMs);
    const current = this.leases.get(runId);
    if (!current || !sameLease(current, requested) || current.expiresAt <= nowMs) return false;
    current.expiresAt = leaseUntilMs;
    return true;
  }

  releaseRun(runId: string, requested: MigrationRunLeaseGuard): void {
    validateLeaseGuard(requested);
    const current = this.leases.get(runId);
    if (current && sameLease(current, requested) && current.expiresAt > requested.nowMs) {
      this.leases.delete(runId);
    }
  }

  close(): void {
    this.byKey.clear();
    this.fences.clear();
    this.leases.clear();
    this.receipts.clear();
    this.objectReceipts.clear();
  }

  private required(runId: string): StoredMigrationRun {
    const state = [...this.byKey.values()].find((candidate) => candidate.plan.runId === runId);
    if (!state) invalid();
    return state;
  }

  private assertLease(runId: string, guard: MigrationRunLeaseGuard): void {
    validateLeaseGuard(guard);
    const current = this.leases.get(runId);
    if (!current || !sameLease(current, guard) || current.expiresAt <= guard.nowMs) invalid();
  }
}

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

function plannedState(
  stateKey: string,
  actor: MigrationActor,
  source: FrozenDoorAgentSource,
  plan: MigrationPlan,
): StoredMigrationRun {
  validateDigest(stateKey);
  const actorDigest = migrationActorDigest(actor);
  validateDigest(actorDigest);
  validateDigest(plan.runId);
  safeJson(source);
  safeJson(plan);
  return { stateKey, actorDigest, source: structuredClone(source), plan: structuredClone(plan),
    phase: "planned", cutoverEpochId: null, report: null, rollback: null, workspaceRollback: null,
    credentialSyncedSourceIds: [], outboxAckedSequence: 0 };
}

function assertReusablePlan(
  existing: StoredMigrationRun,
  stateKey: string,
  actor: MigrationActor,
  source: FrozenDoorAgentSource,
  plan: MigrationPlan,
): void {
  if (existing.stateKey !== stateKey
    || existing.actorDigest !== migrationActorDigest(actor)
    || canonicalJson(existing.source) !== canonicalJson(source)
    || canonicalJson(existing.plan) !== canonicalJson(plan)) invalid();
}

function parseJson<T>(value: unknown, allowArray = false): T {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid(); }
  if (!isRecord(parsed) && !(allowArray && Array.isArray(parsed))) invalid();
  return parsed as T;
}

function parseNullableJson<T>(value: unknown, allowArray = false): T | null {
  if (value === null || value === undefined) return null;
  return parseJson<T>(value, allowArray);
}

function safeJson(value: unknown): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES
    || /scrypt:|passwordEncoded|workspaceRoot|"email"/i.test(json)) invalid();
  return json;
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

function validateSourceUserId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /\s/.test(value)) invalid();
}

function assertReportBinding(state: StoredMigrationRun, report: MigrationReport): void {
  if (report.runId !== state.plan.runId || report.planId !== state.plan.planId
    || report.planDigest !== state.plan.planDigest
    || report.snapshotDigest !== state.plan.snapshotDigest) invalid();
}

function assertRollbackBinding(state: StoredMigrationRun, report: RollbackReport): void {
  if (report.runId !== state.plan.runId || report.planId !== state.plan.planId
    || report.snapshotDigest !== state.plan.snapshotDigest) invalid();
}

function assertEpoch(current: string | null, requested: string): void {
  validateId(requested);
  if (current !== null && current !== requested) approvalInvalid();
}

function validateLeaseWindow(owner: string, nowMs: number, leaseUntilMs: number): void {
  validateId(owner);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseUntilMs) || leaseUntilMs <= nowMs) invalid();
}

function validateRunLease(lease: MigrationRunLease): void {
  if (!lease || typeof lease !== "object") invalid();
  validateId(lease.owner);
  positiveSequence(lease.fence);
}

function validateLeaseGuard(guard: MigrationRunLeaseGuard): void {
  validateRunLease(guard);
  if (!Number.isSafeInteger(guard.nowMs)) invalid();
}

function sameLease(left: MigrationRunLease, right: MigrationRunLease): boolean {
  return left.owner === right.owner && left.fence === right.fence;
}

function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function validateSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function validateDigest(value: string): void {
  if (!SHA256_HEX.test(value)) invalid();
}

function validateId(value: string): void {
  if (!value || value.length > 256 || /\s/.test(value)) invalid();
}

function isPhase(value: unknown): value is MigrationRunPhase {
  return value === "planned" || value === "authorized" || value === "complete" || value === "rolled-back";
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  validateId(result);
  return result;
}

function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

export function migrationActorDigest(actor: MigrationActor): string {
  const stableActor = { scope: actor.scope, operatorUserId: actor.operator.userId };
  return createHash("sha256").update(canonicalJson(stableActor), "utf8").digest("hex");
}

export function migrationPlanStateKey(
  actor: MigrationActor,
  inventory: MigrationInventory,
  policy: MigrationPolicy,
): string {
  return createHash("sha256").update(canonicalJson({
    purpose: "dooragent-migration-state",
    actorDigest: migrationActorDigest(actor),
    inventoryDigest: inventory.inventoryDigest,
    policyDigest: createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex"),
  }), "utf8").digest("hex");
}

function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

function invalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
