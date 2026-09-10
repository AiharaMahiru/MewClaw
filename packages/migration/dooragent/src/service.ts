import { randomUUID } from "node:crypto";

import type {
  AuthCapability,
  AuthImportContext,
} from "dsh-lark-auth";
import { AuthImportError } from "dsh-lark-auth";

import { canonicalJson, digestCanonical } from "./canonical-json.js";
import { catchUpCredentials } from "./credential-catch-up.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import {
  migrationActorDigest,
  migrationPlanStateKey,
  type MigrationRunLeaseGuard,
  type MigrationRunStore,
  type StoredMigrationRun,
} from "./migration-state.js";
import {
  assertMigrationPlanSource,
  assertMigrationPolicy,
  createMigrationPlan,
  dryRunMigrationPlan,
} from "./planner.js";
import { readFrozenDoorAgentSource } from "./source.js";
import {
  acknowledgeUserActionRun,
  authorizeUserActionRun,
  buildUserActionManifest,
  executeUserActionRun,
  resumeUserActionAcknowledgements,
} from "./user-action-runner.js";
import type {
  DoorAgentMigrationService,
  FrozenDoorAgentSource,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationApproval,
  MigrationCredentialSyncReport,
  MigrationInventory,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationPolicy,
  MigrationReport,
  MigrationReportCounts,
  MigrationReportUser,
  MigrationUserResultEvent,
  MigrationReportWorkspace,
  MigrationWorkspaceReportCounts,
  MigrationRollbackWorkspace,
  ReconciliationReport,
  RollbackReport,
  WorkspaceRollbackJournal,
} from "./types.js";
import type { WorkspaceMigrationProvider } from "./workspace-provider.js";

const MAX_CACHE_ENTRIES = 8;
const MAX_TEXT_LENGTH = 256;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_ACTION_LEASE_MS = 300_000;
const DEFAULT_RUN_LEASE_MS = 600_000;

export interface DoorAgentMigrationServiceOptions {
  readSource?: typeof readFrozenDoorAgentSource;
  stateStore: MigrationRunStore;
  deliverUserResult(event: MigrationUserResultEvent): Promise<void>;
  workspaceProvider?: WorkspaceMigrationProvider;
  batchSize?: number;
  actionLeaseMs?: number;
  runLeaseMs?: number;
  now?: () => number;
}

export class DefaultDoorAgentMigrationService implements DoorAgentMigrationService {
  private readonly lifecycle = new AbortController();
  private readonly readSource: typeof readFrozenDoorAgentSource;
  private readonly stateStore: MigrationRunStore;
  private readonly deliverUserResult: DoorAgentMigrationServiceOptions["deliverUserResult"];
  private readonly workspaceProvider: WorkspaceMigrationProvider | undefined;
  private readonly inventories = new Map<string, {
    source: FrozenDoorAgentSource;
    loaded: LoadedDoorAgentSource;
  }>();
  private readonly plans = new Map<string, { plan: MigrationPlan; loaded: LoadedDoorAgentSource }>();
  private readonly activeRuns = new Map<string, {
    cutoverEpochId: string;
    operation: Promise<MigrationReport>;
  }>();
  private readonly batchSize: number;
  private readonly actionLeaseMs: number;
  private readonly runLeaseMs: number;
  private readonly now: () => number;

  constructor(
    private readonly auth: AuthCapability,
    private readonly actor: MigrationActor,
    options: DoorAgentMigrationServiceOptions,
  ) {
    this.readSource = options.readSource ?? readFrozenDoorAgentSource;
    this.stateStore = options.stateStore;
    this.deliverUserResult = options.deliverUserResult;
    this.workspaceProvider = options.workspaceProvider;
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
    this.actionLeaseMs = positiveInteger(options.actionLeaseMs, DEFAULT_ACTION_LEASE_MS);
    this.runLeaseMs = positiveInteger(options.runLeaseMs, DEFAULT_RUN_LEASE_MS);
    this.now = options.now ?? Date.now;
  }

  async inspect(source: FrozenDoorAgentSource, signal?: AbortSignal): Promise<MigrationInventory> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    const loaded = await this.readSource(source, operationSignal);
    throwIfAborted(operationSignal);
    this.cache(this.inventories, loaded.inventory.inventoryDigest, {
      source: structuredClone(source),
      loaded,
    });
    return structuredClone(loaded.inventory);
  }

  async plan(
    inventory: MigrationInventory,
    policy: MigrationPolicy,
    signal?: AbortSignal,
  ): Promise<MigrationPlan> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    assertMigrationPolicy(policy);
    const inspected = this.inventories.get(inventory.inventoryDigest);
    if (!inspected || canonicalJson(inspected.loaded.inventory) !== canonicalJson(inventory)) planInvalid();
    const stateKey = migrationPlanStateKey(this.actor, inventory, policy);
    const recovered = this.stateStore.loadPlan(stateKey);
    if (recovered) return this.bindStoredPlan(recovered, inspected, stateKey).plan;
    const plan = await createMigrationPlan(
      inspected.loaded,
      policy,
      this.auth,
      this.actor,
      operationSignal,
    );
    throwIfAborted(operationSignal);
    const stored = this.stateStore.savePlan(stateKey, this.actor, inspected.source, plan);
    return this.bindStoredPlan(stored, inspected, stateKey).plan;
  }

  async dryRun(plan: MigrationPlan, signal?: AbortSignal): Promise<MigrationReport> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    const entry = await this.loadRunEntry(plan.runId, plan, operationSignal);
    return dryRunMigrationPlan(plan, entry.loaded, this.auth, this.actor, operationSignal);
  }

  async issueApplyApproval(
    plan: MigrationPlan,
    cutoverEpochId: string,
    signal?: AbortSignal,
  ): Promise<MigrationApproval> {
    if (!bounded(cutoverEpochId)) approvalInvalid();
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    return this.withRunLease(plan.runId, async (checkpoint) => {
      const entry = await this.loadRunEntry(plan.runId, plan, operationSignal);
      if (entry.state.phase === "rolled-back") planInvalid();
      assertEpoch(entry.state, cutoverEpochId);
      if (entry.state.phase === "planned") {
        this.stateStore.bindCutoverEpoch(plan.runId, cutoverEpochId, checkpoint());
      } else {
        checkpoint();
      }
      try {
        const issued = await this.auth.issueImportApproval({
          ...context(plan, this.actor, manifestSource(plan), operationSignal),
          cutoverEpochId,
          operation: "apply-run",
          planDigest: plan.planDigest,
          actions: buildUserActionManifest(plan),
        });
        throwIfAborted(operationSignal);
        if (!bounded(issued.approvalRef)) approvalInvalid();
        return { approvalRef: issued.approvalRef, cutoverEpochId };
      } catch (error) {
        throw mapAuthError(error);
      }
    });
  }

  async issueRollbackApproval(
    runId: string,
    signal?: AbortSignal,
  ): Promise<MigrationApproval> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    return this.withRunLease(runId, async (checkpoint) => {
      const entry = await this.loadRunEntry(runId, undefined, operationSignal);
      const cutoverEpochId = entry.state.cutoverEpochId;
      if (entry.state.phase === "planned" || entry.state.phase === "rolled-back"
        || !cutoverEpochId) planInvalid();
      checkpoint();
      try {
        const issued = await this.auth.issueImportApproval({
          ...context(entry.plan, this.actor, manifestSource(entry.plan), operationSignal),
          cutoverEpochId,
          operation: "rollback-run",
        });
        throwIfAborted(operationSignal);
        if (!bounded(issued.approvalRef)) approvalInvalid();
        return { approvalRef: issued.approvalRef, cutoverEpochId };
      } catch (error) {
        throw mapAuthError(error);
      }
    });
  }

  async apply(
    plan: MigrationPlan,
    approval: MigrationApproval,
    signal?: AbortSignal,
  ): Promise<MigrationReport> {
    validateApproval(approval);
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    const stored = this.requiredState(plan.runId, plan);
    assertEpoch(stored, approval.cutoverEpochId);
    const actionCount = buildUserActionManifest(plan).length;
    if (stored.report && stored.outboxAckedSequence === actionCount) return stored.report;
    if (stored.phase === "rolled-back") planInvalid();
    const running = this.activeRuns.get(plan.runId);
    if (running) {
      if (running.cutoverEpochId !== approval.cutoverEpochId) approvalInvalid();
      return running.operation;
    }
    const operation = this.withRunLease(plan.runId, (checkpoint) =>
      this.applyOnce(plan, approval, operationSignal, checkpoint)).finally(() => {
      this.activeRuns.delete(plan.runId);
    });
    this.activeRuns.set(plan.runId, { cutoverEpochId: approval.cutoverEpochId, operation });
    return operation;
  }

  async syncCredentials(
    runId: string,
    source: FrozenDoorAgentSource,
    signal?: AbortSignal,
  ): Promise<MigrationCredentialSyncReport> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    const stored = this.requiredCredentialState(runId, source);
    if (stored.phase !== "complete" || !stored.report || !stored.cutoverEpochId) planInvalid();
    return this.withRunLease(runId, async (checkpoint) => {
      const entry = await this.loadCredentialRunEntry(runId, source, operationSignal);
      if (entry.state.phase !== "complete" || !entry.state.report || !entry.state.cutoverEpochId) planInvalid();
      try {
        return await catchUpCredentials({
          auth: this.auth,
          actor: this.actor,
          plan: entry.plan,
          report: entry.state.report,
          loaded: entry.loaded,
          cutoverEpochId: entry.state.cutoverEpochId,
          syncedSourceIds: new Set(entry.state.credentialSyncedSourceIds),
          markSynced: (sourceId) => {
            this.stateStore.markCredentialSynced(runId, sourceId, checkpoint());
          },
          renewLease: () => { checkpoint(); },
          signal: operationSignal,
        });
      } catch (error) {
        throw mapAuthError(error);
      }
    });
  }

  async reconcile(runId: string, signal?: AbortSignal): Promise<ReconciliationReport> {
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    return this.withRunLease(runId, async (checkpoint) => {
      const entry = await this.loadRunEntry(runId, undefined, operationSignal);
      if (entry.state.phase === "planned") planInvalid();
      checkpoint();
      const result = await this.auth.reconcileImport(
        context(entry.plan, this.actor, manifestSource(entry.plan), operationSignal),
      );
      throwIfAborted(operationSignal);
      validateCounts(result.matched, result.missing, result.mismatched);
      const body = {
        runId,
        planId: entry.plan.planId,
        snapshotDigest: entry.plan.snapshotDigest,
        ...result,
        result: result.missing === 0 && result.mismatched === 0
          ? "matched" as const : "mismatch" as const,
      };
      return { ...body, reportDigest: digestCanonical(body) };
    });
  }

  async rollback(
    runId: string,
    approval: MigrationApproval,
    signal?: AbortSignal,
  ): Promise<RollbackReport> {
    validateApproval(approval);
    const operationSignal = this.operationSignal(signal);
    throwIfAborted(operationSignal);
    const stored = this.requiredState(runId);
    assertEpoch(stored, approval.cutoverEpochId);
    if (stored.rollback) return stored.rollback;
    return this.withRunLease(runId, async (checkpoint) => {
      const entry = await this.loadRunEntry(runId, undefined, operationSignal);
      if (entry.state.phase === "planned") planInvalid();
      try {
        checkpoint();
        const result = await this.auth.rollbackImport({
          ...context(entry.plan, this.actor, manifestSource(entry.plan), operationSignal),
          ...approval,
        });
        throwIfAborted(operationSignal);
        if (result.reasonCode === "ROLLBACK_GUARD_UNAVAILABLE") {
          return buildRollbackReport(
            entry.plan,
            result,
            retainedWorkspaceResults(entry.state.workspaceRollback, result.reasonCode),
            result.reasonCode,
          );
        }
        if (result.rejected > 0) {
          return buildRollbackReport(
            entry.plan,
            result,
            retainedWorkspaceResults(
              entry.state.workspaceRollback,
              sanitizeReason(result.reasonCode) ?? "AUTH_ROLLBACK_REJECTED",
            ),
          );
        }
        if (entry.state.workspaceRollback === null
          && entry.plan.workspaces.some((workspace) => workspace.decision === "migrate")) {
          return buildRollbackReport(entry.plan, result, [], "ROLLBACK_GUARD_UNAVAILABLE");
        }
        const workspaceResults = await rollbackWorkspaces(
          entry,
          this.workspaceProvider,
          approval.cutoverEpochId,
          operationSignal,
          checkpoint,
        );
        const report = buildRollbackReport(entry.plan, result, workspaceResults);
        if (report.result !== "complete") return report;
        return this.stateStore.saveRollback(runId, report, checkpoint()).rollback!;
      } catch (error) {
        throw mapAuthError(error);
      }
    });
  }

  dispose(): void {
    if (!this.lifecycle.signal.aborted) this.lifecycle.abort();
    this.inventories.clear();
    this.plans.clear();
    this.activeRuns.clear();
    this.stateStore.close();
  }

  private async applyOnce(
    plan: MigrationPlan,
    approval: MigrationApproval,
    signal: AbortSignal,
    checkpoint: () => MigrationRunLeaseGuard,
  ): Promise<MigrationReport> {
    const entry = await this.loadRunEntry(plan.runId, plan, signal);
    checkpoint();
    const actionInput = this.userActionInput(entry.state, entry.loaded, plan, approval, signal, checkpoint);
    try {
      const actionCount = buildUserActionManifest(plan).length;
      if (entry.state.report) {
        await resumeUserActionAcknowledgements({
          run: actionInput,
          acknowledgedSequence: entry.state.outboxAckedSequence,
          actionCount,
          onAcknowledged: (sequence, receiptKind) => this.stateStore.markOutboxAcked(
            plan.runId,
            sequence,
            checkpoint(),
            receiptKind,
          ),
        });
        return entry.state.report;
      }
      if (entry.state.phase === "planned") {
        await dryRunMigrationPlan(plan, entry.loaded, this.auth, this.actor, signal);
        throwIfAborted(signal);
        this.stateStore.bindCutoverEpoch(plan.runId, approval.cutoverEpochId, checkpoint());
        await authorizeUserActionRun(actionInput);
        this.stateStore.markAuthorized(plan.runId, approval.cutoverEpochId, checkpoint());
      } else {
        assertEpoch(entry.state, approval.cutoverEpochId);
      }
      const result = await executeUserActionRun(actionInput);
      checkpoint();
      throwIfAborted(signal);
      const users = result.users;
      const report = buildApplyReport(plan, users, result.workspaces);
      const workspaceRollback = buildWorkspaceRollbackJournal(
        plan,
        entry.loaded,
        report.workspaces,
        result.outbox,
        approval.cutoverEpochId,
      );
      const stored = this.stateStore.saveReport(
        plan.runId,
        report,
        checkpoint(),
        workspaceRollback.length === 0 ? undefined : workspaceRollback,
      );
      await acknowledgeUserActionRun(
        actionInput,
        result.outbox,
        (sequence, receiptKind) => this.stateStore.markOutboxAcked(
          plan.runId,
          sequence,
          checkpoint(),
          receiptKind,
        ),
      );
      return stored.report!;
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  private bindStoredPlan(
    stored: StoredMigrationRun,
    inspected: { source: FrozenDoorAgentSource; loaded: LoadedDoorAgentSource },
    stateKey: string,
  ): { plan: MigrationPlan; loaded: LoadedDoorAgentSource } {
    if (stored.stateKey !== stateKey || stored.actorDigest !== migrationActorDigest(this.actor)
      || canonicalJson(stored.source) !== canonicalJson(inspected.source)) planInvalid();
    assertMigrationPlanSource(stored.plan, inspected.loaded);
    this.cache(this.plans, stored.plan.planId, { plan: stored.plan, loaded: inspected.loaded });
    return { plan: structuredClone(stored.plan), loaded: inspected.loaded };
  }

  private async loadRunEntry(
    runId: string,
    expected: MigrationPlan | undefined,
    signal: AbortSignal,
  ): Promise<{ state: StoredMigrationRun; plan: MigrationPlan; loaded: LoadedDoorAgentSource }> {
    const state = this.requiredState(runId, expected);
    throwIfAborted(signal);
    const loaded = await this.readSource(state.source, signal);
    throwIfAborted(signal);
    assertMigrationPlanSource(state.plan, loaded);
    this.cache(this.plans, state.plan.planId, { plan: state.plan, loaded });
    return { state, plan: state.plan, loaded };
  }

  private async loadCredentialRunEntry(
    runId: string,
    source: FrozenDoorAgentSource,
    signal: AbortSignal,
  ): Promise<{ state: StoredMigrationRun; plan: MigrationPlan; loaded: LoadedDoorAgentSource }> {
    const state = this.requiredCredentialState(runId, source);
    throwIfAborted(signal);
    const loaded = await this.readSource(state.source, signal);
    throwIfAborted(signal);
    assertMigrationPlanSource(state.plan, loaded);
    return { state, plan: state.plan, loaded };
  }

  private requiredCredentialState(runId: string, source: FrozenDoorAgentSource): StoredMigrationRun {
    if (!SHA256_HEX.test(runId)) planInvalid();
    const state = this.stateStore.loadRun(runId);
    if (!state || canonicalJson(state.source) !== canonicalJson(source)) planInvalid();
    return state;
  }

  private requiredState(runId: string, expected?: MigrationPlan): StoredMigrationRun {
    if (!SHA256_HEX.test(runId)) planInvalid();
    const state = this.stateStore.loadRun(runId);
    if (!state || state.actorDigest !== migrationActorDigest(this.actor)
      || (expected && canonicalJson(state.plan) !== canonicalJson(expected))) planInvalid();
    return state;
  }

  private userActionInput(
    state: StoredMigrationRun,
    loaded: LoadedDoorAgentSource,
    plan: MigrationPlan,
    approval: MigrationApproval,
    signal: AbortSignal,
    checkpoint: () => MigrationRunLeaseGuard,
  ) {
    return {
      auth: this.auth,
      actor: this.actor,
      plan,
      loaded,
      approval,
      signal,
      workspaceProvider: this.workspaceProvider,
      syncedCredentialSourceIds: new Set(state.credentialSyncedSourceIds),
      options: {
        batchSize: this.batchSize,
        leaseMs: this.actionLeaseMs,
        renewLease: () => { checkpoint(); },
        markCredentialSynced: (sourceUserId: string) => {
          this.stateStore.markCredentialSynced(plan.runId, sourceUserId, checkpoint());
        },
        saveUserResultReceipt: (event: MigrationUserResultEvent) => {
          this.stateStore.saveUserResultReceipt(event, checkpoint());
        },
        saveObjectResultReceipt: (event: MigrationObjectResultEvent) => {
          this.stateStore.saveObjectResultReceipt(event, checkpoint());
        },
        deliverUserResult: this.deliverUserResult,
      },
    };
  }

  private async withRunLease<T>(
    runId: string,
    operation: (checkpoint: () => MigrationRunLeaseGuard) => Promise<T>,
  ): Promise<T> {
    const now = this.now();
    const lease = this.stateStore.claimRun(runId, randomUUID(), now, now + this.runLeaseMs);
    if (!lease) runBusy();
    const checkpoint = (): MigrationRunLeaseGuard => {
      const current = this.now();
      if (!this.stateStore.renewRun(runId, lease, current, current + this.runLeaseMs)) runBusy();
      return { ...lease, nowMs: current };
    };
    try {
      const result = await operation(checkpoint);
      checkpoint();
      return result;
    } finally {
      this.stateStore.releaseRun(runId, { ...lease, nowMs: this.now() });
    }
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
  }

  private cache<T>(map: Map<string, T>, key: string, value: T): void {
    if (!map.has(key) && map.size >= MAX_CACHE_ENTRIES) map.delete(map.keys().next().value as string);
    map.set(key, value);
  }
}

function context(
  plan: MigrationPlan,
  actor: MigrationActor,
  source: AuthImportContext["source"],
  signal?: AbortSignal,
): AuthImportContext {
  return {
    ...actor,
    runId: plan.runId,
    planId: plan.planId,
    snapshotDigest: plan.snapshotDigest,
    source,
    ...(signal ? { signal } : {}),
  };
}

function manifestSource(plan: MigrationPlan): AuthImportContext["source"] {
  return {
    sourceSystem: "dooragent",
    sourceType: "manifest",
    sourceId: plan.snapshotDigest,
    sourceDigest: plan.snapshotDigest,
  };
}

function buildApplyReport(
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

function buildRollbackReport(
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

function buildWorkspaceRollbackJournal(
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

async function rollbackWorkspaces(
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

function retainedWorkspaceResults(
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

function validateApproval(value: MigrationApproval): void {
  if (!value || typeof value !== "object" || !bounded(value.approvalRef)
    || !bounded(value.cutoverEpochId)) throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

function assertEpoch(state: StoredMigrationRun, cutoverEpochId: string): void {
  if (state.cutoverEpochId !== null && state.cutoverEpochId !== cutoverEpochId) {
    throw new DoorAgentMigrationError("APPROVAL_INVALID");
  }
}

function validateCounts(...values: number[]): void {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) planInvalid();
}

function sanitizeReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  return REASON_CODE.test(value) ? value : "AUTH_REJECTED";
}

function bounded(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) planInvalid();
  return result;
}

function mapAuthError(error: unknown): DoorAgentMigrationError {
  if (error instanceof DoorAgentMigrationError) return error;
  if (error instanceof AuthImportError) {
    if (error.code === "APPROVAL_INVALID") return mappedAuthError("APPROVAL_INVALID", error);
    if (error.code === "IMPORT_ABORTED") return mappedAuthError("IMPORT_ABORTED", error);
    if (error.code === "SOURCE_DIGEST_MISMATCH") {
      return mappedAuthError("SOURCE_DIGEST_MISMATCH", error);
    }
    if (error.code === "CREDENTIAL_ROLLBACK_UNAVAILABLE"
      || error.code === "CREDENTIAL_SOURCE_INVALID"
      || error.code === "CREDENTIAL_STATE_CONFLICT") {
      return mappedAuthError(error.code, error);
    }
    if (error.code === "ACTION_LEASE_INVALID") return mappedAuthError("RUN_BUSY", error);
  }
  return new DoorAgentMigrationError("IMPORT_INPUT_INVALID", "IMPORT_INPUT_INVALID", { cause: error });
}

function mappedAuthError(
  code: DoorAgentMigrationError["code"],
  cause: AuthImportError,
): DoorAgentMigrationError {
  return new DoorAgentMigrationError(code, code, { cause });
}

function runBusy(): never {
  throw new DoorAgentMigrationError("RUN_BUSY");
}

function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
