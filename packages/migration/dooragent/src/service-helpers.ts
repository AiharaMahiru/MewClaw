import type { AuthImportContext } from "dsh-lark-auth";
import { AuthImportError } from "dsh-lark-auth";

import { DoorAgentMigrationError } from "./errors.js";
import type { StoredMigrationRun } from "./migration-state.js";
import type { MigrationActor, MigrationApproval, MigrationPlan } from "./types.js";

const MAX_TEXT_LENGTH = 256;
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function context(
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

export function manifestSource(plan: MigrationPlan): AuthImportContext["source"] {
  return {
    sourceSystem: "dooragent",
    sourceType: "manifest",
    sourceId: plan.snapshotDigest,
    sourceDigest: plan.snapshotDigest,
  };
}

export function validateApproval(value: MigrationApproval): void {
  if (!value || typeof value !== "object" || !bounded(value.approvalRef)
    || !bounded(value.cutoverEpochId)) throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

export function assertEpoch(state: StoredMigrationRun, cutoverEpochId: string): void {
  if (state.cutoverEpochId !== null && state.cutoverEpochId !== cutoverEpochId) {
    throw new DoorAgentMigrationError("APPROVAL_INVALID");
  }
}

export function validateCounts(...values: number[]): void {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) planInvalid();
}

export function sanitizeReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  return REASON_CODE.test(value) ? value : "AUTH_REJECTED";
}

export function bounded(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH;
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) planInvalid();
  return result;
}

export function mapAuthError(error: unknown): DoorAgentMigrationError {
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

export function runBusy(): never {
  throw new DoorAgentMigrationError("RUN_BUSY");
}

export function approvalInvalid(): never {
  throw new DoorAgentMigrationError("APPROVAL_INVALID");
}

export function planInvalid(): never {
  throw new DoorAgentMigrationError("PLAN_INVALID");
}
