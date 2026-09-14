import type {
  AuthCapability,
  AuthImportActionDefinition,
  AuthImportActionLease,
  AuthImportContext,
  AuthImportOutboxLease,
  AuthImportOutboxReceipt,
} from "dsh-lark-auth";

import { canonicalJson, digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import type { UserActionRunInput } from "./user-action-runner.js";
import type {
  DoorAgentUserRecord,
  MigrationObjectResultEvent,
  MigrationPlan,
  MigrationPlanUser,
  MigrationUserResultEvent,
} from "./types.js";

const MAX_OPAQUE_TEXT = 256;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

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

export function validateActionLease(
  lease: AuthImportActionLease,
  definition: AuthImportActionDefinition,
): void {
  const value = { actionId: lease.actionId, operation: lease.operation, sequence: lease.sequence,
    source: lease.source, payloadDigest: lease.payloadDigest };
  if (canonicalJson(value) !== canonicalJson(definition) || !bounded(lease.leaseToken)) planInvalid();
}

export function validateOutbox(
  event: AuthImportOutboxLease | AuthImportOutboxReceipt,
  definition: AuthImportActionDefinition,
): void {
  if (event.actionId !== definition.actionId || event.sequence !== definition.sequence
    || !bounded(event.eventId) || !validTimestamp(event.occurredAt)
    || event.result.operation !== definition.operation) planInvalid();
  if ("leaseToken" in event && !bounded(event.leaseToken)) planInvalid();
}

export function actionDefinitions(plan: MigrationPlan): Map<string, AuthImportActionDefinition> {
  return new Map(buildUserActionManifest(plan).map((definition) => [definition.actionId, definition]));
}

function action(planRunId: string, body: Omit<AuthImportActionDefinition, "actionId">): AuthImportActionDefinition {
  return { ...body, actionId: digestCanonical({ runId: planRunId, ...body }) };
}

export function userResultEvent(
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

export function objectResultEvent(
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

export function leaseInput(input: UserActionRunInput) {
  return {
    ...manifestContext(input),
    cutoverEpochId: input.approval.cutoverEpochId,
    limit: input.options.batchSize,
    leaseMs: input.options.leaseMs,
  };
}

export function manifestContext(input: UserActionRunInput): AuthImportContext {
  return itemContext(input, {
    sourceSystem: "dooragent",
    sourceType: "manifest",
    sourceId: input.plan.snapshotDigest,
    sourceDigest: input.plan.snapshotDigest,
  });
}

export function itemContext(
  input: UserActionRunInput,
  source: AuthImportContext["source"],
): AuthImportContext {
  return { ...input.actor, runId: input.plan.runId, planId: input.plan.planId,
    snapshotDigest: input.plan.snapshotDigest, source, ...(input.signal ? { signal: input.signal } : {}) };
}

export function candidate(record: DoorAgentUserRecord, plan: MigrationPlan) {
  return {
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    defaultMode: record.role === "admin" ? "full" as const : "lightweight" as const,
    status: record.status,
    ...(plan.policy.allowCredentialReuse ? { passwordEncoded: record.passwordEncoded } : {}),
  };
}

export async function revokeApproval(
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

export function normalizeTarget(value: string | null): string | null {
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

export function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

export function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}

export function runBusy(): never {
  throw new DoorAgentMigrationError("RUN_BUSY");
}
