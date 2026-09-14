import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { DoorAgentMigrationError } from "./errors.js";
import type {
  FrozenDoorAgentSource,
  MigrationActor,
  MigrationInventory,
  MigrationPlan,
  MigrationPolicy,
  MigrationReport,
  RollbackReport,
} from "./types.js";
import type {
  MigrationRunLease,
  MigrationRunLeaseGuard,
  MigrationRunPhase,
  StoredMigrationRun,
} from "./migration-state.js";

export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const MAX_JSON_BYTES = 4_194_304;

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

export function assertReusablePlan(
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

export function parseJson<T>(value: unknown, allowArray = false): T {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { invalid(); }
  if (!isRecord(parsed) && !(allowArray && Array.isArray(parsed))) invalid();
  return parsed as T;
}

export function parseNullableJson<T>(value: unknown, allowArray = false): T | null {
  if (value === null || value === undefined) return null;
  return parseJson<T>(value, allowArray);
}

export function safeJson(value: unknown): string {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES
    || /scrypt:|passwordEncoded|workspaceRoot|"email"/i.test(json)) invalid();
  return json;
}

export function validateSourceUserId(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /\s/.test(value)) invalid();
}

export function assertReportBinding(state: StoredMigrationRun, report: MigrationReport): void {
  if (report.runId !== state.plan.runId || report.planId !== state.plan.planId
    || report.planDigest !== state.plan.planDigest
    || report.snapshotDigest !== state.plan.snapshotDigest) invalid();
}

export function assertRollbackBinding(state: StoredMigrationRun, report: RollbackReport): void {
  if (report.runId !== state.plan.runId || report.planId !== state.plan.planId
    || report.snapshotDigest !== state.plan.snapshotDigest) invalid();
}

export function assertEpoch(current: string | null, requested: string): void {
  validateId(requested);
  if (current !== null && current !== requested) approvalInvalid();
}

export function validateLeaseWindow(owner: string, nowMs: number, leaseUntilMs: number): void {
  validateId(owner);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(leaseUntilMs) || leaseUntilMs <= nowMs) invalid();
}

export function validateRunLease(lease: MigrationRunLease): void {
  if (!lease || typeof lease !== "object") invalid();
  validateId(lease.owner);
  positiveSequence(lease.fence);
}

export function validateLeaseGuard(guard: MigrationRunLeaseGuard): void {
  validateRunLease(guard);
  if (!Number.isSafeInteger(guard.nowMs)) invalid();
}

export function sameLease(left: MigrationRunLease, right: MigrationRunLease): boolean {
  return left.owner === right.owner && left.fence === right.fence;
}

export function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return Number(value);
}

export function validateSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid();
}

export function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
  return Number(value);
}

export function validateDigest(value: string): void {
  if (!SHA256_HEX.test(value)) invalid();
}

export function validateId(value: string): void {
  if (!value || value.length > 256 || /\s/.test(value)) invalid();
}

export function isPhase(value: unknown): value is MigrationRunPhase {
  return value === "planned" || value === "authorized" || value === "complete" || value === "rolled-back";
}

export function nullableText(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value);
  validateId(result);
  return result;
}

export function text(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

export function invalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
