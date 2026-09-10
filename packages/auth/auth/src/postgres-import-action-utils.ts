import type {
  AuthImportActionDefinition,
  AuthImportActionLease,
  AuthImportOutboxLease,
  AuthResourceClaimResult,
  AuthUserImportResult,
} from "./capability.js";
import { generateOpaqueToken, hashOpaqueToken } from "./crypto.js";
import type {
  AuthImportTransaction,
  BoundImportAction,
  ImportOutboxRecord,
} from "./postgres-import-store.js";

export async function leaseActions(
  transaction: AuthImportTransaction,
  actions: AuthImportActionDefinition[],
  runId: string,
  leaseMs: number,
  now: string,
): Promise<AuthImportActionLease[]> {
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const leases: AuthImportActionLease[] = [];
  for (const action of actions) {
    const leaseToken = generateOpaqueToken();
    await transaction.leaseImportAction(runId, action.actionId, hashOpaqueToken(leaseToken), leaseExpiresAt);
    leases.push({ ...action, leaseToken, leaseExpiresAt });
  }
  return leases;
}

export async function leaseOutbox(
  transaction: AuthImportTransaction,
  records: ImportOutboxRecord[],
  leaseMs: number,
  now: string,
): Promise<AuthImportOutboxLease[]> {
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const leases: AuthImportOutboxLease[] = [];
  for (const record of records) {
    const leaseToken = generateOpaqueToken();
    await transaction.leaseOutboxEvent(record.eventId, hashOpaqueToken(leaseToken), leaseExpiresAt);
    leases.push({ ...record, leaseToken, leaseExpiresAt });
  }
  return leases;
}

export async function completeUserAction(
  transaction: AuthImportTransaction,
  action: BoundImportAction,
  result: AuthUserImportResult,
  now: string,
): Promise<void> {
  await transaction.completeImportAction(action, {
    operation: "apply-user",
    result: result.result,
    targetUserId: result.userId ?? null,
    reasonCode: result.reasonCode ?? null,
  }, now);
}

export async function completeResourceAction(
  transaction: AuthImportTransaction,
  action: BoundImportAction,
  result: AuthResourceClaimResult,
  resourceId: string,
  now: string,
): Promise<void> {
  await transaction.completeImportAction(action, {
    operation: "claim-resource",
    result: result.result,
    targetUserId: "userId" in result ? result.userId : null,
    targetResourceId: resourceId,
    reasonCode: "reasonCode" in result ? result.reasonCode : null,
  }, now);
}
