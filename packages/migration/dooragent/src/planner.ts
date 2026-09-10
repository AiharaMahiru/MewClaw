import { createHash } from "node:crypto";

import {
  inspectImportCredential,
  type AuthCapability,
  type AuthUserImportPlan,
} from "dsh-lark-auth";

import { canonicalJson, digestCanonical } from "./canonical-json.js";
import { DoorAgentMigrationError, throwIfAborted } from "./errors.js";
import type {
  DoorAgentUserRecord,
  DoorAgentWorkspaceRecord,
  LoadedDoorAgentSource,
  MigrationActor,
  MigrationPlan,
  MigrationPlanCredentialSync,
  MigrationPlanUser,
  MigrationPlanWorkspace,
  MigrationPolicy,
  MigrationReport,
  MigrationReportCounts,
  MigrationReportUser,
  MigrationReportWorkspace,
  MigrationWorkspaceReportCounts,
} from "./types.js";

type PlanningAuth = Pick<AuthCapability, "dryRunUserImport">;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_TARGET_ID_LENGTH = 256;

export async function createMigrationPlan(
  loaded: LoadedDoorAgentSource,
  policy: MigrationPolicy,
  auth: PlanningAuth,
  actor: MigrationActor,
  signal?: AbortSignal,
): Promise<MigrationPlan> {
  validateLoadedSource(loaded);
  assertMigrationPolicy(policy);
  const policyDigest = digestCanonical(policy);
  const planningId = digestCanonical({
    purpose: "dooragent-user-plan",
    inventoryDigest: loaded.inventory.inventoryDigest,
    policyDigest,
  });
  const users = await evaluateUsers(loaded.records, policy, auth, actor, {
    planId: planningId,
    runId: deriveRunId(planningId),
    snapshotDigest: loaded.inventory.snapshotDigest,
  }, signal);
  const workspaces = policy.includeAssociatedData
    ? evaluateWorkspaces(loaded, users)
    : [];
  return buildPlan(loaded, policy, policyDigest, users, workspaces);
}

export async function dryRunMigrationPlan(
  plan: MigrationPlan,
  loaded: LoadedDoorAgentSource,
  auth: PlanningAuth,
  actor: MigrationActor,
  signal?: AbortSignal,
): Promise<MigrationReport> {
  assertMigrationPlanSource(plan, loaded);
  const current = await evaluateUsers(loaded.records, plan.policy, auth, actor, {
    planId: plan.planId,
    runId: plan.runId,
    snapshotDigest: plan.snapshotDigest,
  }, signal);
  const workspaces = plan.policy.includeAssociatedData ? evaluateWorkspaces(loaded, current) : [];
  if (canonicalJson(current) !== canonicalJson(plan.users)
    || canonicalJson(workspaces) !== canonicalJson(plan.workspaces)) {
    throw new DoorAgentMigrationError("PLAN_STALE");
  }
  return buildReport(plan, current);
}

export function assertMigrationPlanSource(
  plan: MigrationPlan,
  loaded: LoadedDoorAgentSource,
): void {
  validateLoadedSource(loaded);
  validatePlan(plan, loaded);
}

export function assertMigrationPolicy(policy: MigrationPolicy): void {
  validatePolicy(policy);
  if (policy.includeAssociatedData) planInvalid();
}

interface PlanningIds {
  planId: string;
  runId: string;
  snapshotDigest: string;
}

async function evaluateUsers(
  records: DoorAgentUserRecord[],
  policy: MigrationPolicy,
  auth: PlanningAuth,
  actor: MigrationActor,
  ids: PlanningIds,
  signal?: AbortSignal,
): Promise<MigrationPlanUser[]> {
  const users: MigrationPlanUser[] = [];
  for (const record of sortRecords(records)) {
    throwIfAborted(signal);
    const source = policy.includeAssociatedData ? associatedSourceRef(record) : sourceRef(record);
    const result = await auth.dryRunUserImport({
      ...actor,
      ...ids,
      source,
      candidate: candidate(record, policy),
      ...(signal ? { signal } : {}),
    });
    users.push(normalizeAuthPlan(record, result, ids.snapshotDigest, actor.operator.userId));
  }
  return users;
}

function buildPlan(
  loaded: LoadedDoorAgentSource,
  policy: MigrationPolicy,
  policyDigest: string,
  users: MigrationPlanUser[],
  workspaces: MigrationPlanWorkspace[],
): MigrationPlan {
  const body = {
    version: 1 as const,
    sourceSystem: "dooragent" as const,
    snapshotDigest: loaded.inventory.snapshotDigest,
    inventoryDigest: loaded.inventory.inventoryDigest,
    policy: { ...policy },
    policyDigest,
    users,
    workspaces,
  };
  const planDigest = digestCanonical(body);
  return deepFreeze({
    ...body,
    planDigest,
    planId: planDigest,
    runId: deriveRunId(planDigest),
  });
}

function validatePlan(plan: MigrationPlan, loaded: LoadedDoorAgentSource): void {
  validatePolicy(plan.policy);
  if (plan.version !== 1 || plan.sourceSystem !== "dooragent") planInvalid();
  if (plan.workspaces !== undefined && !Array.isArray(plan.workspaces)) planInvalid();
  if (plan.snapshotDigest !== loaded.inventory.snapshotDigest
    || plan.inventoryDigest !== loaded.inventory.inventoryDigest) planInvalid();
  if (plan.policyDigest !== digestCanonical(plan.policy)) planInvalid();
  const body = {
    version: plan.version,
    sourceSystem: plan.sourceSystem,
    snapshotDigest: plan.snapshotDigest,
    inventoryDigest: plan.inventoryDigest,
    policy: plan.policy,
    policyDigest: plan.policyDigest,
    users: plan.users,
    ...(plan.workspaces === undefined ? {} : { workspaces: plan.workspaces }),
  };
  const digest = digestCanonical(body);
  if (plan.planDigest !== digest || plan.planId !== digest || plan.runId !== deriveRunId(digest)) planInvalid();
}

function validateLoadedSource(loaded: LoadedDoorAgentSource): void {
  const inventory = loaded?.inventory;
  if (!inventory || inventory.sourceSystem !== "dooragent" || inventory.manifestVersion < 4) planInvalid();
  if (!SHA256_HEX.test(inventory.snapshotDigest) || !Array.isArray(inventory.users)) planInvalid();
  const users = [...inventory.users].sort(compareSourceId);
  const content = {
    sourceSystem: inventory.sourceSystem,
    snapshotDigest: inventory.snapshotDigest,
    manifestVersion: inventory.manifestVersion,
    counts: [{ sourceType: "user" as const, count: users.length }],
    users,
  };
  if (inventory.inventoryDigest !== digestCanonical(content)) planInvalid();
  validateRecordBinding(loaded.records, users);
  if (loaded.workspaces) validateWorkspaceBinding(loaded.workspaces, loaded.records);
}

function validateWorkspaceBinding(
  records: readonly DoorAgentWorkspaceRecord[],
  users: LoadedDoorAgentSource["records"],
): void {
  if (records.length !== users.length) planInvalid();
  const userIds = new Set(users.map((user) => user.sourceId));
  if (records.some((record) => !userIds.has(record.sourceUserId)
    || !SHA256_HEX.test(record.rootPathSha256) || !SHA256_HEX.test(record.sourceDigest)
    || (record.status === "manifested" && !record.aggregate))) planInvalid();
  if (new Set(records.map((record) => record.sourceUserId)).size !== records.length) planInvalid();
}

function validateRecordBinding(
  records: DoorAgentUserRecord[],
  users: LoadedDoorAgentSource["inventory"]["users"],
): void {
  if (!Array.isArray(records) || records.length !== users.length) planInvalid();
  const sorted = sortRecords(records);
  for (const [index, record] of sorted.entries()) {
    const user = users[index];
    if (!user || record.sourceId !== user.sourceId || record.sourceDigest !== user.sourceDigest
      || record.role !== user.role || record.status !== user.status) planInvalid();
  }
  if (new Set(sorted.map((record) => record.sourceId)).size !== sorted.length) planInvalid();
}

function normalizeAuthPlan(
  record: DoorAgentUserRecord,
  result: AuthUserImportPlan,
  snapshotDigest: string,
  operatorUserId: string,
): MigrationPlanUser {
  if (!SHA256_HEX.test(result.candidateDigest)) planInvalid();
  if (!isDecision(result.decision) || !isCredential(result.credential)) planInvalid();
  const targetUserId = normalizeTarget(result.targetUserId);
  if (result.decision === "merge" && targetUserId === null) planInvalid();
  if (result.decision === "create" && targetUserId !== null) planInvalid();
  if (result.decision === "merge" && targetUserId === operatorUserId) planInvalid();
  return {
    source: sourceRef(record),
    decision: result.decision,
    targetUserId,
    credential: sanitizeCredential(result.credential),
    candidateDigest: result.candidateDigest,
    credentialSync: credentialSyncCandidate(record, result, snapshotDigest, targetUserId),
    reasonCode: sanitizeReason(result.reasonCode),
  };
}

function buildReport(plan: MigrationPlan, users: MigrationPlanUser[]): MigrationReport {
  const results = users.map(toReportUser);
  const counts = countResults(results);
  const workspaces = plan.workspaces.map(toReportWorkspace);
  const workspaceCounts = countWorkspaceResults(workspaces);
  const body = {
    mode: "dry-run" as const,
    status: counts.rejected > 0 || workspaceCounts.rejected > 0
      ? "blocked" as const : "ready" as const,
    runId: plan.runId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    snapshotDigest: plan.snapshotDigest,
    counts,
    users: results,
    workspaceCounts,
    workspaces,
  };
  return deepFreeze({ ...body, reportDigest: digestCanonical(body) });
}

function evaluateWorkspaces(
  loaded: LoadedDoorAgentSource,
  users: readonly MigrationPlanUser[],
): MigrationPlanWorkspace[] {
  const userPlans = new Map(users.map((user) => [user.source.sourceId, user]));
  return [...(loaded.workspaces ?? [])].sort((left, right) => left.sourceUserId.localeCompare(right.sourceUserId))
    .map((record) => {
      const source = {
        sourceSystem: "dooragent" as const,
        sourceType: "workspace" as const,
        sourceId: record.sourceUserId,
        sourceDigest: record.sourceDigest,
      };
      const user = userPlans.get(record.sourceUserId);
      const targetUserId = user?.targetUserId ?? null;
      const identityMissing = !user || user.decision === "reject"
        || (user.decision !== "create" && targetUserId === null);
      const reasonCode = record.status === "missing" ? "SOURCE_WORKSPACE_MISSING"
        : record.aggregate && (record.aggregate.symlinkCount > 0 || record.aggregate.specialFileCount > 0)
          ? "UNSUPPORTED_FILE_TYPE"
          : identityMissing ? "IDENTITY_MAPPING_MISSING" : null;
      const decision = reasonCode ? "reject" as const : "migrate" as const;
      return {
        source, decision, targetUserId, aggregate: record.aggregate,
        candidateDigest: digestCanonical({ source, targetUserId, aggregate: record.aggregate }),
        reasonCode,
      };
    });
}

function toReportWorkspace(workspace: MigrationPlanWorkspace): MigrationReportWorkspace {
  return {
    source: workspace.source,
    targetUserId: workspace.targetUserId,
    targetWorkspaceId: null,
    result: workspace.decision === "migrate" ? "migrated" : "rejected",
    reasonCode: workspace.reasonCode,
  };
}

function countWorkspaceResults(users: readonly MigrationReportWorkspace[]): MigrationWorkspaceReportCounts {
  const counts = { total: users.length, migrated: 0, merged: 0, rejected: 0 };
  for (const user of users) counts[user.result] += 1;
  return counts;
}

function toReportUser(user: MigrationPlanUser): MigrationReportUser {
  const resetReason = user.credential.action === "reset_required"
    ? sanitizeReason(user.credential.reason)
    : null;
  const result = user.decision === "reject" ? "rejected"
    : resetReason ? "reset_required"
      : user.decision === "create" ? "migrated" : "merged";
  return {
    source: user.source,
    targetUserId: user.targetUserId,
    result,
    reasonCode: user.reasonCode ?? resetReason,
  };
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

function candidate(record: DoorAgentUserRecord, policy: MigrationPolicy) {
  return {
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    defaultMode: record.role === "admin" ? "full" as const : "lightweight" as const,
    status: record.status,
    ...(policy.allowCredentialReuse ? { passwordEncoded: record.passwordEncoded } : {}),
  };
}

function credentialSyncCandidate(
  record: DoorAgentUserRecord,
  result: AuthUserImportPlan,
  snapshotDigest: string,
  targetUserId: string | null,
): MigrationPlanCredentialSync | null {
  if (result.decision !== "merge" || targetUserId === null || result.credential.action !== "reuse") {
    return null;
  }
  return buildCredentialSyncCandidate(record, targetUserId, snapshotDigest);
}

export function buildCredentialSyncCandidate(
  record: DoorAgentUserRecord,
  targetUserId: string,
  snapshotDigest: string,
): MigrationPlanCredentialSync {
  const inspected = inspectImportCredential({ sourceSystem: "dooragent", encoded: record.passwordEncoded });
  if (inspected.action !== "reuse" || inspected.profile !== "dooragent-scrypt-v1") planInvalid();
  return {
    source: {
      sourceSystem: "dooragent",
      sourceType: "credential",
      sourceId: record.sourceId,
      sourceDigest: record.sourceDigest,
    },
    targetUserId,
    expectedRole: record.role,
    expectedDefaultMode: record.role === "admin" ? "full" : "lightweight",
    expectedStatus: "active",
    credentialDigest: credentialSyncDigest({
      sourceId: record.sourceId,
      sourceDigest: record.sourceDigest,
      snapshotDigest,
      targetUserId,
      expectedRole: record.role,
      expectedDefaultMode: record.role === "admin" ? "full" : "lightweight",
      expectedStatus: "active",
      normalizedEncoded: inspected.normalizedEncoded,
    }),
    rollbackSnapshotRef: rollbackSnapshotRef(snapshotDigest, record.sourceId),
  };
}

function sourceRef(record: DoorAgentUserRecord): MigrationPlanUser["source"] {
  return {
    sourceSystem: "dooragent",
    sourceType: "user",
    sourceId: record.sourceId,
    sourceDigest: record.sourceDigest,
  };
}

function associatedSourceRef(record: DoorAgentUserRecord) {
  return {
    sourceSystem: "dooragent" as const,
    sourceType: "identity" as const,
    sourceId: `associated-user:${record.sourceId}`,
    sourceDigest: record.sourceDigest,
  };
}

function rollbackSnapshotRef(snapshotDigest: string, sourceId: string): string {
  return `vault:dsh/dooragent/credential-sync/${snapshotDigest}/${sourceId}`;
}

function credentialSyncDigest(input: {
  sourceId: string;
  sourceDigest: string;
  snapshotDigest: string;
  targetUserId: string;
  expectedRole: DoorAgentUserRecord["role"];
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  normalizedEncoded: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    source: {
      sourceSystem: "dooragent",
      sourceType: "credential",
      sourceId: input.sourceId,
      sourceDigest: input.sourceDigest,
    },
    snapshotDigest: input.snapshotDigest,
    targetUserId: input.targetUserId,
    expectedRole: input.expectedRole,
    expectedDefaultMode: input.expectedDefaultMode,
    expectedStatus: input.expectedStatus,
    normalizedEncoded: input.normalizedEncoded,
  }), "utf8").digest("hex");
}

function validatePolicy(policy: MigrationPolicy): void {
  if (!policy || typeof policy !== "object" || typeof policy.includeAssociatedData !== "boolean"
    || typeof policy.allowCredentialReuse !== "boolean") planInvalid();
  if (Object.keys(policy).sort().join("\0") !== "allowCredentialReuse\0includeAssociatedData") planInvalid();
}

function sanitizeCredential(value: AuthUserImportPlan["credential"]): AuthUserImportPlan["credential"] {
  if (value.action === "reuse") return { action: "reuse", algorithm: "scrypt", profile: value.profile };
  return { action: "reset_required", reason: sanitizeReason(value.reason) ?? "CREDENTIAL_UNSUPPORTED" };
}

function isCredential(value: AuthUserImportPlan["credential"]): boolean {
  return value.action === "reuse"
    ? value.algorithm === "scrypt" && (value.profile === "dsh-native" || value.profile === "dooragent-scrypt-v1")
    : value.action === "reset_required";
}

function isDecision(value: string): value is MigrationPlanUser["decision"] {
  return value === "create" || value === "merge" || value === "reject";
}

function sanitizeReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  return REASON_CODE.test(value) ? value : "AUTH_REJECTED";
}

function normalizeTarget(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!value || value.length > MAX_TARGET_ID_LENGTH || /\s/.test(value)) planInvalid();
  return value;
}

function sortRecords(records: DoorAgentUserRecord[]): DoorAgentUserRecord[] {
  return [...records].sort(compareSourceId);
}

function compareSourceId(left: { sourceId: string }, right: { sourceId: string }): number {
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
}

function deriveRunId(planId: string): string {
  return createHash("sha256").update(`dooragent-run\0${planId}`, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
