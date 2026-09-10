import type { DatabaseSync } from "node:sqlite";

import { canonicalJson, digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import type {
  MigrationRunLeaseGuard,
  StoredMigrationRun,
} from "./migration-state.js";
import type {
  MigrationObjectResultEvent,
  MigrationUserResultEvent,
} from "./types.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_TEXT_LENGTH = 256;
const MAX_PAYLOAD_BYTES = 65_536;

export interface StoredMigrationUserResultReceipt {
  event: MigrationUserResultEvent;
  payloadDigest: string;
  recordedAtMs: number;
}

export interface StoredMigrationObjectResultReceipt {
  event: MigrationObjectResultEvent;
  payloadDigest: string;
  recordedAtMs: number;
}

export class MemoryMigrationUserResultReceipts {
  private readonly byEventId = new Map<string, StoredMigrationUserResultReceipt>();
  private readonly eventIdBySequence = new Map<string, string>();

  save(
    event: MigrationUserResultEvent,
    state: StoredMigrationRun,
    recordedAtMs: number,
  ): StoredMigrationUserResultReceipt {
    assertUserReceiptBinding(state, event);
    const receipt = buildUserReceipt(event, recordedAtMs);
    const sequenceKey = receiptSequenceKey(event.runId, event.sequence);
    const existingId = this.eventIdBySequence.get(sequenceKey);
    const existing = this.byEventId.get(event.eventId)
      ?? (existingId ? this.byEventId.get(existingId) : undefined);
    if (existing) {
      if (!sameReceiptPayload(existing, receipt)) invalid();
      return structuredClone(existing);
    }
    this.byEventId.set(event.eventId, receipt);
    this.eventIdBySequence.set(sequenceKey, event.eventId);
    return structuredClone(receipt);
  }

  load(eventId: string): StoredMigrationUserResultReceipt | undefined {
    validateText(eventId);
    const receipt = this.byEventId.get(eventId);
    return receipt ? structuredClone(receipt) : undefined;
  }

  has(runId: string, sequence: number): boolean {
    return this.eventIdBySequence.has(receiptSequenceKey(runId, sequence));
  }

  clear(): void {
    this.byEventId.clear();
    this.eventIdBySequence.clear();
  }
}

export class MemoryMigrationObjectResultReceipts {
  private readonly byEventId = new Map<string, StoredMigrationObjectResultReceipt>();
  private readonly eventIdBySequence = new Map<string, string>();

  save(
    event: MigrationObjectResultEvent,
    state: StoredMigrationRun,
    recordedAtMs: number,
  ): StoredMigrationObjectResultReceipt {
    assertObjectReceiptBinding(state, event);
    const receipt = buildObjectReceipt(event, recordedAtMs);
    const sequenceKey = receiptSequenceKey(event.runId, event.sequence);
    const existingId = this.eventIdBySequence.get(sequenceKey);
    const existing = this.byEventId.get(event.eventId)
      ?? (existingId ? this.byEventId.get(existingId) : undefined);
    if (existing) {
      if (!sameReceiptPayload(existing, receipt)) invalid();
      return structuredClone(existing);
    }
    this.byEventId.set(event.eventId, receipt);
    this.eventIdBySequence.set(sequenceKey, event.eventId);
    return structuredClone(receipt);
  }

  load(eventId: string): StoredMigrationObjectResultReceipt | undefined {
    validateText(eventId);
    const receipt = this.byEventId.get(eventId);
    return receipt ? structuredClone(receipt) : undefined;
  }

  has(runId: string, sequence: number): boolean {
    return this.eventIdBySequence.has(receiptSequenceKey(runId, sequence));
  }

  clear(): void {
    this.byEventId.clear();
    this.eventIdBySequence.clear();
  }
}

export function createUserResultReceiptSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migration_user_result_receipts (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK (
        length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
      ),
      recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
      UNIQUE (run_id, sequence),
      FOREIGN KEY (run_id) REFERENCES migration_runs(run_id) ON DELETE RESTRICT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS migration_object_result_receipts (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      payload_json TEXT NOT NULL,
      payload_digest TEXT NOT NULL CHECK (
        length(payload_digest) = 64 AND payload_digest NOT GLOB '*[^0-9a-f]*'
      ),
      recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
      UNIQUE (run_id, sequence),
      FOREIGN KEY (run_id) REFERENCES migration_runs(run_id) ON DELETE RESTRICT
    ) STRICT;
  `);
}

export function saveSqliteUserResultReceipt(
  database: DatabaseSync,
  event: MigrationUserResultEvent,
  guard: MigrationRunLeaseGuard,
): StoredMigrationUserResultReceipt {
  const receipt = buildUserReceipt(event, guard.nowMs);
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = loadFencedState(database, event.runId, guard);
    assertUserReceiptBinding(state, event);
    const existing = loadConflictingReceipt(database, event.eventId, event.runId, event.sequence);
    if (existing) {
      if (!sameReceiptPayload(existing, receipt)) invalid();
      database.exec("COMMIT");
      return existing;
    }
    insertReceipt(database, receipt);
    database.exec("COMMIT");
    return structuredClone(receipt);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始失败。 */ }
    if (error instanceof DoorAgentMigrationError) throw error;
    invalid();
  }
}

export function loadSqliteUserResultReceipt(
  database: DatabaseSync,
  eventId: string,
): StoredMigrationUserResultReceipt | undefined {
  validateText(eventId);
  const row = database.prepare(`
    SELECT event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms
    FROM migration_user_result_receipts WHERE event_id = ?
  `).get(eventId);
  return row === undefined ? undefined : parseUserReceiptRow(row);
}

export function saveSqliteObjectResultReceipt(
  database: DatabaseSync,
  event: MigrationObjectResultEvent,
  guard: MigrationRunLeaseGuard,
): StoredMigrationObjectResultReceipt {
  const receipt = buildObjectReceipt(event, guard.nowMs);
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = loadFencedState(database, event.runId, guard);
    assertObjectReceiptBinding(state, event);
    const existing = loadConflictingObjectReceipt(database, event.eventId, event.runId, event.sequence);
    if (existing) {
      if (!sameReceiptPayload(existing, receipt)) invalid();
      database.exec("COMMIT");
      return existing;
    }
    insertObjectReceipt(database, receipt);
    database.exec("COMMIT");
    return structuredClone(receipt);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* 保留原始失败。 */ }
    if (error instanceof DoorAgentMigrationError) throw error;
    invalid();
  }
}

export function loadSqliteObjectResultReceipt(
  database: DatabaseSync,
  eventId: string,
): StoredMigrationObjectResultReceipt | undefined {
  validateText(eventId);
  const row = database.prepare(`
    SELECT event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms
    FROM migration_object_result_receipts WHERE event_id = ?
  `).get(eventId);
  return row === undefined ? undefined : parseObjectReceiptRow(row);
}

function loadFencedState(
  database: DatabaseSync,
  runId: string,
  guard: MigrationRunLeaseGuard,
): StoredMigrationRun {
  validateGuard(guard);
  const row = database.prepare(`
    SELECT state_key, actor_digest, source_json, plan_json, phase, cutover_epoch_id,
           report_json, rollback_json, workspace_rollback_json, outbox_acked_sequence
    FROM migration_runs
    WHERE run_id = ? AND lease_owner = ? AND lease_fence = ? AND lease_expires_at > ?
  `).get(runId, guard.owner, guard.fence, guard.nowMs) as Record<string, unknown> | undefined;
  if (!row) invalid();
  return {
    stateKey: text(row.state_key), actorDigest: text(row.actor_digest),
    source: parseJson(row.source_json), plan: parseJson(row.plan_json),
    phase: phase(row.phase), cutoverEpochId: nullableText(row.cutover_epoch_id),
    report: row.report_json === null ? null : parseJson(row.report_json),
    rollback: row.rollback_json === null ? null : parseJson(row.rollback_json),
    workspaceRollback: row.workspace_rollback_json === null || row.workspace_rollback_json === undefined
      ? null : parseJson(row.workspace_rollback_json, true),
    credentialSyncedSourceIds: [],
    outboxAckedSequence: nonNegativeInteger(row.outbox_acked_sequence),
  };
}

function loadConflictingReceipt(
  database: DatabaseSync,
  eventId: string,
  runId: string,
  sequence: number,
): StoredMigrationUserResultReceipt | undefined {
  const row = database.prepare(`
    SELECT event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms
    FROM migration_user_result_receipts
    WHERE event_id = ? OR (run_id = ? AND sequence = ?)
    LIMIT 1
  `).get(eventId, runId, sequence);
  return row === undefined ? undefined : parseUserReceiptRow(row);
}

function loadConflictingObjectReceipt(
  database: DatabaseSync,
  eventId: string,
  runId: string,
  sequence: number,
): StoredMigrationObjectResultReceipt | undefined {
  const row = database.prepare(`
    SELECT event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms
    FROM migration_object_result_receipts
    WHERE event_id = ? OR (run_id = ? AND sequence = ?)
    LIMIT 1
  `).get(eventId, runId, sequence);
  return row === undefined ? undefined : parseObjectReceiptRow(row);
}

function insertReceipt(database: DatabaseSync, receipt: StoredMigrationUserResultReceipt): void {
  database.prepare(`
    INSERT INTO migration_user_result_receipts
      (event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(receipt.event.eventId, receipt.event.runId, receipt.event.sequence,
    canonicalJson(receipt.event), receipt.payloadDigest, receipt.recordedAtMs);
}

function insertObjectReceipt(database: DatabaseSync, receipt: StoredMigrationObjectResultReceipt): void {
  database.prepare(`
    INSERT INTO migration_object_result_receipts
      (event_id, run_id, sequence, payload_json, payload_digest, recorded_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(receipt.event.eventId, receipt.event.runId, receipt.event.sequence,
    canonicalJson(receipt.event), receipt.payloadDigest, receipt.recordedAtMs);
}

function parseUserReceiptRow(value: unknown): StoredMigrationUserResultReceipt {
  if (!record(value)) invalid();
  const event = parseJson<MigrationUserResultEvent>(value.payload_json);
  const receipt = buildUserReceipt(event, nonNegativeInteger(value.recorded_at_ms));
  if (text(value.event_id) !== event.eventId || text(value.run_id) !== event.runId
    || positiveInteger(value.sequence) !== event.sequence
    || text(value.payload_digest) !== receipt.payloadDigest) invalid();
  return receipt;
}

function parseObjectReceiptRow(value: unknown): StoredMigrationObjectResultReceipt {
  if (!record(value)) invalid();
  const event = parseJson<MigrationObjectResultEvent>(value.payload_json);
  const receipt = buildObjectReceipt(event, nonNegativeInteger(value.recorded_at_ms));
  if (text(value.event_id) !== event.eventId || text(value.run_id) !== event.runId
    || positiveInteger(value.sequence) !== event.sequence
    || text(value.payload_digest) !== receipt.payloadDigest) invalid();
  return receipt;
}

function buildUserReceipt(
  event: MigrationUserResultEvent,
  recordedAtMs: number,
): StoredMigrationUserResultReceipt {
  validateUserEvent(event);
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) invalid();
  const payload = canonicalJson(event);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES
    || /scrypt:|password|workspace|token|cookie|approval|lease/i.test(payload)) invalid();
  return { event: structuredClone(event), payloadDigest: digestCanonical(event), recordedAtMs };
}

function buildObjectReceipt(
  event: MigrationObjectResultEvent,
  recordedAtMs: number,
): StoredMigrationObjectResultReceipt {
  validateObjectEvent(event);
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0) invalid();
  const payload = canonicalJson(event);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES
    || /D:\/|resourcePath|token|cookie|approval|lease/i.test(payload)) invalid();
  return { event: structuredClone(event), payloadDigest: digestCanonical(event), recordedAtMs };
}

function assertUserReceiptBinding(state: StoredMigrationRun, event: MigrationUserResultEvent): void {
  if (state.phase !== "complete" || !state.report || state.plan.runId !== event.runId
    || state.plan.planId !== event.planId || state.plan.snapshotDigest !== event.snapshotDigest
    || state.cutoverEpochId !== event.cutoverEpochId) invalid();
  const planned = state.plan.users.filter((user) => user.decision !== "reject")[event.sequence - 1];
  if (!planned || canonicalJson(planned.source) !== canonicalJson(event.source)) invalid();
  const reportUser = state.report.users.find((user) =>
    canonicalJson(user.source) === canonicalJson(event.source));
  const eventResult = { source: event.source, targetUserId: event.targetUserId,
    result: event.result, reasonCode: event.reasonCode };
  if (!reportUser || canonicalJson(reportUser) !== canonicalJson(eventResult)) invalid();
}

function assertObjectReceiptBinding(state: StoredMigrationRun, event: MigrationObjectResultEvent): void {
  if (state.phase !== "complete" || !state.report || state.plan.runId !== event.runId
    || state.plan.planId !== event.planId || state.plan.snapshotDigest !== event.snapshotDigest
    || state.cutoverEpochId !== event.cutoverEpochId) invalid();
  const userActionCount = state.plan.users.filter((user) =>
    user.decision !== "reject" && !(state.plan.policy.includeAssociatedData && user.decision === "merge")).length;
  const plannedIndex = state.plan.workspaces
    .filter((workspace) => workspace.decision !== "reject")
    .findIndex((workspace) => canonicalJson(workspace.source) === canonicalJson(event.source));
  if (plannedIndex < 0 || event.sequence !== userActionCount + plannedIndex + 1) invalid();
  const reportWorkspace = state.report.workspaces.find((workspace) =>
    canonicalJson(workspace.source) === canonicalJson(event.source));
  if (!reportWorkspace) invalid();
  const expectedResult = event.result === "claimed"
    ? "migrated" : event.result === "unchanged" ? "merged" : "rejected";
  const expected = {
    source: event.source,
    targetUserId: event.targetUserId,
    targetWorkspaceId: event.targetResourceId,
    result: expectedResult,
    reasonCode: event.reasonCode,
  };
  if (canonicalJson(reportWorkspace) !== canonicalJson(expected)) invalid();
}

function validateUserEvent(event: MigrationUserResultEvent): void {
  if (!record(event) || !validText(event.eventId) || !SHA256_HEX.test(event.runId)
    || !SHA256_HEX.test(event.planId) || !SHA256_HEX.test(event.snapshotDigest)
    || !validText(event.cutoverEpochId) || !validTimestamp(event.occurredAt)
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.ignorable !== false
    || !record(event.source) || event.source.sourceSystem !== "dooragent"
    || event.source.sourceType !== "user" || !validText(event.source.sourceId)
    || !SHA256_HEX.test(event.source.sourceDigest)) invalid();
  if (event.targetUserId !== null && !validText(event.targetUserId)) invalid();
  if (!isResult(event.result) || (event.reasonCode !== null && !REASON_CODE.test(event.reasonCode))) invalid();
}

function validateObjectEvent(event: MigrationObjectResultEvent): void {
  if (!record(event) || !validText(event.eventId) || !SHA256_HEX.test(event.runId)
    || !SHA256_HEX.test(event.planId) || !SHA256_HEX.test(event.snapshotDigest)
    || !validText(event.cutoverEpochId) || !validTimestamp(event.occurredAt)
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.ignorable !== false
    || !record(event.source) || event.source.sourceSystem !== "dooragent"
    || event.source.sourceType !== "workspace" || !validText(event.source.sourceId)
    || !SHA256_HEX.test(event.source.sourceDigest)) invalid();
  if (event.targetUserId !== null && !validText(event.targetUserId)) invalid();
  if (event.targetResourceId !== null && !validText(event.targetResourceId)) invalid();
  if (!isObjectResult(event.result)
    || (event.reasonCode !== null && !REASON_CODE.test(event.reasonCode))) invalid();
}

function sameReceiptPayload(
  left: { event: { eventId: string; runId: string; sequence: number }; payloadDigest: string },
  right: { event: { eventId: string; runId: string; sequence: number }; payloadDigest: string },
): boolean {
  return left.event.eventId === right.event.eventId
    && left.event.runId === right.event.runId
    && left.event.sequence === right.event.sequence
    && left.payloadDigest === right.payloadDigest
    && canonicalJson(left.event) === canonicalJson(right.event);
}

function parseJson<T>(value: unknown, allowArray = false): T {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) invalid();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!record(parsed) && !(allowArray && Array.isArray(parsed))) invalid();
    return parsed as T;
  } catch {
    invalid();
  }
}

function validateGuard(guard: MigrationRunLeaseGuard): void {
  if (!guard || !validText(guard.owner) || !Number.isSafeInteger(guard.fence)
    || guard.fence < 1 || !Number.isSafeInteger(guard.nowMs)) invalid();
}

function receiptSequenceKey(runId: string, sequence: number): string {
  if (!SHA256_HEX.test(runId) || !Number.isSafeInteger(sequence) || sequence < 1) invalid();
  return `${runId}:${sequence}`;
}

function validTimestamp(value: string): boolean {
  return validText(value) && Number.isFinite(Date.parse(value));
}

function isResult(value: unknown): value is MigrationUserResultEvent["result"] {
  return value === "migrated" || value === "merged" || value === "rejected"
    || value === "reset_required";
}

function isObjectResult(value: unknown): value is MigrationObjectResultEvent["result"] {
  return value === "claimed" || value === "unchanged" || value === "rejected";
}

function phase(value: unknown): StoredMigrationRun["phase"] {
  if (value !== "planned" && value !== "authorized" && value !== "complete"
    && value !== "rolled-back") invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

function validateText(value: unknown): asserts value is string {
  if (!validText(value)) invalid();
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= MAX_TEXT_LENGTH && !/\s/.test(value);
}

function text(value: unknown): string {
  validateText(value);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
