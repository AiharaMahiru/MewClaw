import { canonicalJson } from "./canonical-json.js";
import {
  assertEpoch,
  assertReportBinding,
  assertReusablePlan,
  assertRollbackBinding,
  invalid,
  migrationActorDigest,
  safeJson,
  sameLease,
  validateDigest,
  validateLeaseGuard,
  validateLeaseWindow,
  validateRunLease,
  validateSequence,
  validateSourceUserId,
} from "./migration-state-shared.js";
import {
  MemoryMigrationObjectResultReceipts,
  MemoryMigrationUserResultReceipts,
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

export {
  migrationActorDigest,
  migrationPlanStateKey,
} from "./migration-state-shared.js";
export { SqliteMigrationRunStore } from "./migration-state-sqlite.js";

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

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
