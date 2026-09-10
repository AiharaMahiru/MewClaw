import type {
  AuthCapability,
  AuthImportActionDefinition,
  AuthImportActionLease,
  AuthImportActionResult,
  AuthImportContext,
  AuthImportOutboxLease,
  AuthImportOutboxReceipt,
  AuthUserImportResult,
} from "dsh-lark-auth";

import { canonicalJson, digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import { resultUsers, resultWorkspaces } from "./user-action-report.js";
import type { WorkspaceMigrationProvider, WorkspaceMigrationResult } from "./workspace-provider.js";
import type {
  DoorAgentUserRecord,
  DoorAgentWorkspaceRecord,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationApproval,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationPlanUser,
  MigrationReportUser,
  MigrationReportWorkspace,
  MigrationUserResultEvent,
} from "./types.js";

const MAX_OPAQUE_TEXT = 256;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface UserActionRunOptions {
  batchSize: number;
  leaseMs: number;
  renewLease(): void;
  markCredentialSynced(sourceUserId: string): void;
  saveUserResultReceipt(event: MigrationUserResultEvent): void;
  saveObjectResultReceipt(event: MigrationObjectResultEvent): void;
  deliverUserResult(event: MigrationUserResultEvent): Promise<void>;
}

export interface UserActionRunInput {
  auth: AuthCapability;
  actor: MigrationActor;
  plan: MigrationPlan;
  loaded: LoadedDoorAgentSource;
  approval: MigrationApproval;
  options: UserActionRunOptions;
  workspaceProvider: WorkspaceMigrationProvider | undefined;
  syncedCredentialSourceIds?: ReadonlySet<string>;
  signal?: AbortSignal;
}

export interface UserActionRunResult {
  users: MigrationReportUser[];
  workspaces: MigrationReportWorkspace[];
  outbox: AuthImportOutboxLease[];
}

interface ActionExecutionState {
  completed: Set<string>;
  credentialSynced: Set<string>;
  plannedUsers: Map<string, MigrationPlanUser>;
  targetUsers: Map<string, string>;
  workspaceResults: Map<string, WorkspaceMigrationResult>;
}

export function buildUserActionManifest(plan: MigrationPlan): AuthImportActionDefinition[] {
  let sequence = 0;
  const actions = plan.users.flatMap((planned) => {
    if (planned.decision === "reject"
      || plan.policy.includeAssociatedData && planned.decision === "merge") return [];
    sequence += 1;
    return [action(plan.runId, {
      operation: "apply-user" as const,
      sequence,
      source: planned.source,
      payloadDigest: planned.candidateDigest,
    })];
  });
  const workspaceActions = plan.workspaces.flatMap((planned) => {
    if (planned.decision === "reject") return [];
    sequence += 1;
    return [action(plan.runId, {
      operation: "claim-resource" as const,
      sequence,
      source: planned.source,
      payloadDigest: planned.candidateDigest,
    })];
  });
  return [...actions, ...workspaceActions];
}

export const buildMigrationActionManifest = buildUserActionManifest;

export async function authorizeUserActionRun(input: UserActionRunInput): Promise<void> {
  const result = await input.auth.authorizeImportRun({
    ...manifestContext(input),
    ...input.approval,
    planDigest: input.plan.planDigest,
    actions: buildUserActionManifest(input.plan),
  });
  if (result.authorized !== true) approvalInvalid();
}

export async function executeUserActionRun(input: UserActionRunInput): Promise<UserActionRunResult> {
  const actions = buildUserActionManifest(input.plan);
  const definitions = new Map(actions.map((action) => [action.actionId, action]));
  const records = {
    users: new Map(input.loaded.records.map((record) => [record.sourceId, record])),
    workspaces: new Map((input.loaded.workspaces ?? []).map((record) => [record.sourceUserId, record])),
  };
  const state = createActionExecutionState(input.plan, input.syncedCredentialSourceIds);
  await recoverCompletedActions(input, definitions, records.users, state);
  const workspaceResults = await processActionLeases(input, definitions, records, state);
  const outbox = await collectResultOutbox(input, definitions);
  return {
    users: resultUsers(input.plan, actions, outbox),
    workspaces: resultWorkspaces(input.plan, actions, outbox, workspaceResults),
    outbox,
  };
}

function createActionExecutionState(
  plan: MigrationPlan,
  syncedCredentialSourceIds: ReadonlySet<string> | undefined,
): ActionExecutionState {
  const targetUsers = new Map<string, string>();
  for (const user of plan.users) {
    if (user.targetUserId) targetUsers.set(user.source.sourceId, user.targetUserId);
  }
  return {
    completed: new Set(),
    credentialSynced: new Set(syncedCredentialSourceIds ?? []),
    plannedUsers: new Map(plan.users.map((user) => [user.source.sourceId, user])),
    targetUsers,
    workspaceResults: new Map(),
  };
}

async function recoverCompletedActions(
  input: UserActionRunInput,
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
  users: ReadonlyMap<string, DoorAgentUserRecord>,
  state: ActionExecutionState,
): Promise<void> {
  let afterSequence = 0;
  while (afterSequence < definitions.size) {
    input.options.renewLease();
    throwIfAborted(input.signal);
    const receipts = await input.auth.listImportOutboxReceipts({
      ...manifestContext(input),
      cutoverEpochId: input.approval.cutoverEpochId,
      afterSequence,
      limit: input.options.batchSize,
    });
    if (receipts.length > input.options.batchSize || receipts.length === 0) return;
    for (const receipt of [...receipts].sort((left, right) => left.sequence - right.sequence)) {
      const definition = definitions.get(receipt.actionId);
      if (!definition || receipt.sequence !== afterSequence + 1) runBusy();
      validateOutbox(receipt, definition);
      if (receipt.acknowledgedAt !== null && !validTimestamp(receipt.acknowledgedAt)) planInvalid();
      recordCompletedResult(state, definition, receipt.result);
      if (definition.operation === "apply-user") {
        const record = users.get(definition.source.sourceId);
        if (!record || record.sourceDigest !== definition.source.sourceDigest) planInvalid();
        await syncCredentialIfNeeded(input, state, record);
      }
      state.completed.add(definition.actionId);
      afterSequence = receipt.sequence;
    }
  }
}

function recordUserResult(
  state: ActionExecutionState,
  definition: AuthImportActionDefinition,
  result: AuthUserImportResult,
): void {
  if (result.result === "rejected") throw new DoorAgentMigrationError("PLAN_STALE");
  const targetUserId = normalizeTarget(result.userId ?? null);
  if (!targetUserId) throw new DoorAgentMigrationError("PLAN_STALE");
  bindTargetUser(state, definition.source.sourceId, targetUserId);
}

function recordCompletedResult(
  state: ActionExecutionState,
  definition: AuthImportActionDefinition,
  result: AuthImportActionResult,
): void {
  if (result.operation === "apply-user") {
    if (result.result === "rejected") throw new DoorAgentMigrationError("PLAN_STALE");
    const targetUserId = normalizeTarget(result.targetUserId);
    if (!targetUserId) throw new DoorAgentMigrationError("PLAN_STALE");
    bindTargetUser(state, definition.source.sourceId, targetUserId);
    return;
  }
  if (result.result === "rejected" || !result.targetResourceId) {
    throw new DoorAgentMigrationError("PLAN_STALE");
  }
  const targetUserId = normalizeTarget(result.targetUserId);
  if (!targetUserId) throw new DoorAgentMigrationError("PLAN_STALE");
  state.workspaceResults.set(definition.actionId, {
    result: result.result === "claimed" ? "migrated" : "merged",
    workspaceId: result.targetResourceId,
    path: "",
  });
}

function bindTargetUser(state: ActionExecutionState, sourceUserId: string, targetUserId: string): void {
  const existing = state.targetUsers.get(sourceUserId);
  if (existing && existing !== targetUserId) throw new DoorAgentMigrationError("PLAN_STALE");
  state.targetUsers.set(sourceUserId, targetUserId);
}

export async function acknowledgeUserActionRun(
  input: UserActionRunInput,
  outbox: readonly AuthImportOutboxLease[],
  onAcknowledged: (sequence: number, receiptKind: "user" | "object") => void,
): Promise<void> {
  const definitions = actionDefinitions(input.plan);
  let expected = 1;
  for (const event of [...outbox].sort((left, right) => left.sequence - right.sequence)) {
    const definition = definitions.get(event.actionId);
    if (!definition || event.sequence !== expected) runBusy();
    await deliverAndAcknowledge(input, event, definitions);
    onAcknowledged(event.sequence, definition.operation === "apply-user" ? "user" : "object");
    expected += 1;
  }
}

export async function resumeUserActionAcknowledgements(input: {
  run: UserActionRunInput;
  acknowledgedSequence: number;
  actionCount: number;
  onAcknowledged(sequence: number, receiptKind: "user" | "object"): void;
}): Promise<void> {
  const definitions = actionDefinitions(input.run.plan);
  let current = await recoverAcknowledgedReceipts(input, definitions);
  while (current < input.actionCount) {
    input.run.options.renewLease();
    throwIfAborted(input.run.signal);
    const leased = await input.run.auth.leaseImportOutbox(leaseInput(input.run));
    if (leased.length === 0) runBusy();
    for (const event of [...leased].sort((left, right) => left.sequence - right.sequence)) {
      const definition = definitions.get(event.actionId);
      if (!definition || event.sequence !== current + 1) runBusy();
      validateOutbox(event, definition);
      await deliverAndAcknowledge(input.run, event, definitions);
      input.onAcknowledged(event.sequence, definition.operation === "apply-user" ? "user" : "object");
      current = event.sequence;
    }
  }
}

async function recoverAcknowledgedReceipts(
  input: Parameters<typeof resumeUserActionAcknowledgements>[0],
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
): Promise<number> {
  let current = input.acknowledgedSequence;
  while (current < input.actionCount) {
    input.run.options.renewLease();
    throwIfAborted(input.run.signal);
    const receipts = await input.run.auth.listImportOutboxReceipts({
      ...manifestContext(input.run),
      cutoverEpochId: input.run.approval.cutoverEpochId,
      afterSequence: current,
      limit: input.run.options.batchSize,
    });
    if (receipts.length === 0) return current;
    for (const receipt of receipts) {
      const definition = definitions.get(receipt.actionId);
      if (!definition || receipt.sequence !== current + 1) runBusy();
      validateOutbox(receipt, definition);
      if (receipt.acknowledgedAt === null) return current;
      if (!validTimestamp(receipt.acknowledgedAt)) planInvalid();
      input.onAcknowledged(receipt.sequence, definition.operation === "apply-user" ? "user" : "object");
      current = receipt.sequence;
    }
  }
  return current;
}

async function deliverAndAcknowledge(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
): Promise<void> {
  const definition = definitions.get(event.actionId);
  if (!definition) planInvalid();
  validateOutbox(event, definition);
  input.options.renewLease();
  if (definition.operation === "apply-user") {
    const resultEvent = userResultEvent(input, event, definition);
    // receipt 先于 Cordis 投递，确保进程在任意外部 ack 前已有可恢复审计事实。
    input.options.saveUserResultReceipt(resultEvent);
    await input.options.deliverUserResult(resultEvent);
  } else {
    input.options.saveObjectResultReceipt(objectResultEvent(input, event, definition));
  }
  await acknowledgeEvent(input, event);
}

async function acknowledgeEvent(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
): Promise<void> {
  input.options.renewLease();
  throwIfAborted(input.signal);
  await input.auth.ackImportOutbox({
    ...manifestContext(input),
    cutoverEpochId: input.approval.cutoverEpochId,
    eventId: event.eventId,
    leaseToken: event.leaseToken,
  });
}

async function processActionLeases(
  input: UserActionRunInput,
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
  records: { users: ReadonlyMap<string, DoorAgentUserRecord>; workspaces: ReadonlyMap<string, DoorAgentWorkspaceRecord> },
  state: ActionExecutionState,
): Promise<Map<string, WorkspaceMigrationResult>> {
  while (state.completed.size < definitions.size) {
    input.options.renewLease();
    throwIfAborted(input.signal);
    const leases = await input.auth.leaseImportActions(leaseInput(input));
    if (leases.length > input.options.batchSize) planInvalid();
    if (leases.length === 0) return state.workspaceResults;
    for (const lease of [...leases].sort((left, right) => left.sequence - right.sequence)) {
      const definition = definitions.get(lease.actionId);
      if (!definition || state.completed.has(lease.actionId)
        || definition.sequence !== state.completed.size + 1) runBusy();
      validateActionLease(lease, definition);
      if (definition.operation === "apply-user") {
        const record = records.users.get(definition.source.sourceId);
        if (!record || record.sourceDigest !== definition.source.sourceDigest) planInvalid();
        const result = await applyLeasedUser(input, lease, record);
        recordUserResult(state, definition, result);
        await syncCredentialIfNeeded(input, state, record);
      } else {
        const record = records.workspaces.get(definition.source.sourceId);
        if (!record || record.sourceDigest !== definition.source.sourceDigest) planInvalid();
        const result = await applyLeasedWorkspace(input, lease, record, records.users, state.targetUsers);
        state.workspaceResults.set(lease.actionId, result);
      }
      state.completed.add(lease.actionId);
    }
  }
  return state.workspaceResults;
}

async function syncCredentialIfNeeded(
  input: UserActionRunInput,
  state: ActionExecutionState,
  record: DoorAgentUserRecord,
): Promise<void> {
  const planned = state.plannedUsers.get(record.sourceId);
  const sync = planned?.credentialSync;
  if (!sync || state.credentialSynced.has(record.sourceId)) return;
  const targetUserId = state.targetUsers.get(record.sourceId);
  if (!targetUserId || targetUserId !== sync.targetUserId) {
    throw new DoorAgentMigrationError("PLAN_STALE");
  }
  const base = itemContext(input, sync.source);
  input.options.renewLease();
  const issued = await input.auth.issueImportApproval({
    ...base,
    cutoverEpochId: input.approval.cutoverEpochId,
    operation: "sync-credential",
    targetUserId,
    expectedRole: sync.expectedRole,
    expectedDefaultMode: sync.expectedDefaultMode,
    expectedStatus: sync.expectedStatus,
    credentialDigest: sync.credentialDigest,
    rollbackSnapshotRef: sync.rollbackSnapshotRef,
  });
  try {
    input.options.renewLease();
    throwIfAborted(input.signal);
    await input.auth.syncCredential({
      ...base,
      approvalRef: issued.approvalRef,
      cutoverEpochId: input.approval.cutoverEpochId,
      targetUserId,
      expectedRole: sync.expectedRole,
      expectedDefaultMode: sync.expectedDefaultMode,
      expectedStatus: sync.expectedStatus,
      sourceCredential: record.passwordEncoded,
      credentialDigest: sync.credentialDigest,
      rollbackSnapshotRef: sync.rollbackSnapshotRef,
    });
    state.credentialSynced.add(record.sourceId);
    input.options.markCredentialSynced(record.sourceId);
  } catch (error) {
    await revokeApproval(input.auth, base, issued.approvalRef);
    throw error;
  }
}

async function applyLeasedUser(
  input: UserActionRunInput,
  lease: AuthImportActionLease,
  record: DoorAgentUserRecord,
): Promise<AuthUserImportResult> {
  const base = itemContext(input, lease.source);
  input.options.renewLease();
  const issued = await input.auth.issueImportApproval({
    ...base,
    cutoverEpochId: input.approval.cutoverEpochId,
    operation: "apply-user",
    candidateDigest: lease.payloadDigest,
  });
  try {
    input.options.renewLease();
    return await input.auth.applyUserImport({
      ...base,
      approvalRef: issued.approvalRef,
      cutoverEpochId: input.approval.cutoverEpochId,
      candidate: candidate(record, input.plan),
      actionLease: {
        actionId: lease.actionId,
        leaseToken: lease.leaseToken,
        payloadDigest: lease.payloadDigest,
      },
    });
  } catch (error) {
    await revokeApproval(input.auth, base, issued.approvalRef);
    throw error;
  }
}

async function applyLeasedWorkspace(
  input: UserActionRunInput,
  lease: AuthImportActionLease,
  record: DoorAgentWorkspaceRecord,
  users: ReadonlyMap<string, DoorAgentUserRecord>,
  targetUsers: ReadonlyMap<string, string>,
): Promise<WorkspaceMigrationResult> {
  if (!input.workspaceProvider || !record.aggregate) throw new DoorAgentMigrationError("IMPORT_INPUT_INVALID");
  const user = users.get(record.sourceUserId);
  const target = input.plan.workspaces.find((item) => item.source.sourceId === record.sourceUserId);
  const targetUserId = targetUsers.get(record.sourceUserId) ?? target?.targetUserId ?? null;
  if (!user || !target || !targetUserId || target.targetUserId && target.targetUserId !== targetUserId) {
    throw new DoorAgentMigrationError("PLAN_STALE");
  }
  input.options.renewLease();
  const workspace = await input.workspaceProvider.migrate({
    sourcePath: record.workspaceRoot,
    targetUserId,
    role: user.role,
    aggregate: record.aggregate,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const base = itemContext(input, lease.source);
  const issued = await input.auth.issueImportApproval({
    ...base,
    cutoverEpochId: input.approval.cutoverEpochId,
    operation: "claim-resource",
    resourceType: "workspace",
    resourceId: workspace.workspaceId,
    resourcePath: workspace.path,
    targetUserId,
  });
  try {
    input.options.renewLease();
    const claimed = await input.auth.claimResource({
      ...base,
      approvalRef: issued.approvalRef,
      cutoverEpochId: input.approval.cutoverEpochId,
      resourceType: "workspace",
      resourceId: workspace.workspaceId,
      resourcePath: workspace.path,
      targetUserId,
      actionLease: {
        actionId: lease.actionId,
        leaseToken: lease.leaseToken,
        payloadDigest: lease.payloadDigest,
      },
    });
    if (claimed.result === "rejected" || claimed.userId !== targetUserId) planInvalid();
    return workspace;
  } catch (error) {
    await revokeApproval(input.auth, base, issued.approvalRef);
    throw error;
  }
}

async function collectResultOutbox(
  input: UserActionRunInput,
  definitions: ReadonlyMap<string, AuthImportActionDefinition>,
): Promise<AuthImportOutboxLease[]> {
  const events = new Map<string, AuthImportOutboxLease>();
  while (events.size < definitions.size) {
    input.options.renewLease();
    throwIfAborted(input.signal);
    const leased = await input.auth.leaseImportOutbox(leaseInput(input));
    if (leased.length > input.options.batchSize) planInvalid();
    if (leased.length === 0) runBusy();
    for (const event of leased) {
      const definition = definitions.get(event.actionId);
      if (!definition || events.has(event.actionId)) planInvalid();
      validateOutbox(event, definition);
      events.set(event.actionId, event);
    }
  }
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}

function validateActionLease(
  lease: AuthImportActionLease,
  definition: AuthImportActionDefinition,
): void {
  const value = { actionId: lease.actionId, operation: lease.operation, sequence: lease.sequence,
    source: lease.source, payloadDigest: lease.payloadDigest };
  if (canonicalJson(value) !== canonicalJson(definition) || !bounded(lease.leaseToken)) planInvalid();
}

function validateOutbox(
  event: AuthImportOutboxLease | AuthImportOutboxReceipt,
  definition: AuthImportActionDefinition,
): void {
  if (event.actionId !== definition.actionId || event.sequence !== definition.sequence
    || !bounded(event.eventId) || !validTimestamp(event.occurredAt)
    || event.result.operation !== definition.operation) planInvalid();
  if ("leaseToken" in event && !bounded(event.leaseToken)) planInvalid();
}

function actionDefinitions(plan: MigrationPlan): Map<string, AuthImportActionDefinition> {
  return new Map(buildUserActionManifest(plan).map((definition) => [definition.actionId, definition]));
}

function action(planRunId: string, body: Omit<AuthImportActionDefinition, "actionId">): AuthImportActionDefinition {
  return { ...body, actionId: digestCanonical({ runId: planRunId, ...body }) };
}

function userResultEvent(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
  definition: AuthImportActionDefinition,
): MigrationUserResultEvent {
  if (event.result.operation !== "apply-user") planInvalid();
  return {
    eventId: event.eventId,
    runId: input.plan.runId,
    planId: input.plan.planId,
    cutoverEpochId: input.approval.cutoverEpochId,
    snapshotDigest: input.plan.snapshotDigest,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    ignorable: false,
    source: definition.source as MigrationPlanUser["source"],
    targetUserId: normalizeTarget(event.result.targetUserId),
    result: event.result.result,
    reasonCode: sanitizeReason(event.result.reasonCode),
  };
}

function objectResultEvent(
  input: UserActionRunInput,
  event: AuthImportOutboxLease,
  definition: AuthImportActionDefinition,
): MigrationObjectResultEvent {
  if (event.result.operation !== "claim-resource") planInvalid();
  return {
    eventId: event.eventId,
    runId: input.plan.runId,
    planId: input.plan.planId,
    cutoverEpochId: input.approval.cutoverEpochId,
    snapshotDigest: input.plan.snapshotDigest,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    ignorable: false,
    source: definition.source as MigrationPlan["workspaces"][number]["source"],
    targetUserId: normalizeTarget(event.result.targetUserId),
    targetResourceId: normalizeTarget(event.result.targetResourceId),
    result: event.result.result,
    reasonCode: sanitizeReason(event.result.reasonCode),
  };
}

function leaseInput(input: UserActionRunInput) {
  return {
    ...manifestContext(input),
    cutoverEpochId: input.approval.cutoverEpochId,
    limit: input.options.batchSize,
    leaseMs: input.options.leaseMs,
  };
}

function manifestContext(input: UserActionRunInput): AuthImportContext {
  return itemContext(input, {
    sourceSystem: "dooragent",
    sourceType: "manifest",
    sourceId: input.plan.snapshotDigest,
    sourceDigest: input.plan.snapshotDigest,
  });
}

function itemContext(
  input: UserActionRunInput,
  source: AuthImportContext["source"],
): AuthImportContext {
  return { ...input.actor, runId: input.plan.runId, planId: input.plan.planId,
    snapshotDigest: input.plan.snapshotDigest, source, ...(input.signal ? { signal: input.signal } : {}) };
}

function candidate(record: DoorAgentUserRecord, plan: MigrationPlan) {
  return {
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    defaultMode: record.role === "admin" ? "full" as const : "lightweight" as const,
    status: record.status,
    ...(plan.policy.allowCredentialReuse ? { passwordEncoded: record.passwordEncoded } : {}),
  };
}

async function revokeApproval(
  auth: AuthCapability,
  context: AuthImportContext,
  approvalRef: string,
): Promise<void> {
  try {
    await auth.revokeImportApproval({ ...context, approvalRef });
  } catch {
    // 原错误优先；批准仍由服务端 TTL 和一次性消费语义 fail closed。
  }
}

function normalizeTarget(value: string | null): string | null {
  if (value === null) return null;
  if (!bounded(value) || /\s/.test(value)) planInvalid();
  return value;
}

function sanitizeReason(value: string | null): string | null {
  if (value === null) return null;
  return REASON_CODE.test(value) ? value : "AUTH_REJECTED";
}

function bounded(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OPAQUE_TEXT;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}

function runBusy(): never {
  throw new DoorAgentMigrationError("RUN_BUSY");
}
