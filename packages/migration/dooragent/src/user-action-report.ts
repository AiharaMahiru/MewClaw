import type {
  AuthImportActionDefinition,
  AuthImportOutboxLease,
} from "dsh-lark-auth";

import { DoorAgentMigrationError } from "./errors.js";
import type {
  MigrationPlan,
  MigrationPlanUser,
  MigrationReportUser,
  MigrationReportWorkspace,
} from "./types.js";
import type { WorkspaceMigrationResult } from "./workspace-provider.js";

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_TARGET_ID_LENGTH = 256;

export function resultUsers(
  plan: MigrationPlan,
  actions: readonly AuthImportActionDefinition[],
  outbox: readonly AuthImportOutboxLease[],
): MigrationReportUser[] {
  const actionBySource = new Map(actions.map((action) => [actionKey(action), action.actionId]));
  const eventByAction = new Map(outbox.map((event) => [event.actionId, event]));
  return plan.users.map((planned) => {
    if (planned.decision === "reject") return rejectedUser(planned);
    if (plan.policy.includeAssociatedData && planned.decision === "merge") {
      return { source: planned.source, targetUserId: planned.targetUserId,
        result: "merged", reasonCode: null };
    }
    const event = eventByAction.get(actionBySource.get(actionKey({ source: planned.source })) ?? "");
    if (!event) runBusy();
    return normalizeOutboxUser(planned, event);
  });
}

export function resultWorkspaces(
  plan: MigrationPlan,
  actions: readonly AuthImportActionDefinition[],
  outbox: readonly AuthImportOutboxLease[],
  workspaceResults: ReadonlyMap<string, WorkspaceMigrationResult>,
): MigrationReportWorkspace[] {
  const actionBySource = new Map(actions.map((action) => [actionKey(action), action.actionId]));
  const eventByAction = new Map(outbox.map((event) => [event.actionId, event]));
  return plan.workspaces.map((planned) => {
    if (planned.decision === "reject") return rejectedWorkspace(planned);
    const actionId = actionBySource.get(actionKey({ source: planned.source }));
    const event = actionId ? eventByAction.get(actionId) : undefined;
    const copied = actionId ? workspaceResults.get(actionId) : undefined;
    if (!actionId || !event || !copied || event.result.operation !== "claim-resource"
      || event.result.result === "rejected" || !event.result.targetResourceId
      || !event.result.targetUserId
      || (planned.targetUserId !== null && event.result.targetUserId !== planned.targetUserId)
      || event.result.targetResourceId !== copied.workspaceId) planInvalid();
    return {
      source: planned.source,
      targetUserId: event.result.targetUserId,
      targetWorkspaceId: copied.workspaceId,
      result: copied.result,
      reasonCode: null,
    };
  });
}

function normalizeOutboxUser(
  planned: MigrationPlanUser,
  event: AuthImportOutboxLease,
): MigrationReportUser {
  const result = event.result;
  if (result.operation !== "apply-user" || !isUserResult(result.result)) planInvalid();
  const targetUserId = normalizeTarget(result.targetUserId);
  if ((result.result === "migrated" || result.result === "merged") && targetUserId === null) planInvalid();
  if (planned.decision === "merge" && targetUserId !== planned.targetUserId) {
    throw new DoorAgentMigrationError("PLAN_STALE");
  }
  return { source: planned.source, targetUserId, result: result.result,
    reasonCode: sanitizeReason(result.reasonCode) };
}

function actionKey(value: { source: { sourceType: string; sourceId: string } }): string {
  return `${value.source.sourceType}\0${value.source.sourceId}`;
}

function rejectedUser(planned: MigrationPlanUser): MigrationReportUser {
  return { source: planned.source, targetUserId: planned.targetUserId, result: "rejected",
    reasonCode: planned.reasonCode ?? "IDENTITY_CONFLICT" };
}

function rejectedWorkspace(planned: MigrationPlan["workspaces"][number]): MigrationReportWorkspace {
  return { source: planned.source, targetUserId: planned.targetUserId, targetWorkspaceId: null,
    result: "rejected", reasonCode: planned.reasonCode ?? "IDENTITY_MAPPING_MISSING" };
}

function normalizeTarget(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > MAX_TARGET_ID_LENGTH || /\s/.test(value)) {
    planInvalid();
  }
  return value;
}

function sanitizeReason(value: string | null): string | null {
  if (value === null) return null;
  return REASON_CODE.test(value) ? value : "AUTH_REJECTED";
}

function isUserResult(value: string): value is MigrationReportUser["result"] {
  return value === "migrated" || value === "merged"
    || value === "rejected" || value === "reset_required";
}

function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}

function runBusy(): never {
  throw new DoorAgentMigrationError("RUN_BUSY");
}
