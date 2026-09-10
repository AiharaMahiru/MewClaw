import type {
  CutoverDeltaEntry,
  CutoverEpochRecord,
  CutoverJournal,
  RuntimePhase,
} from "./types.js";
import { assertIsoTimestamp, assertSha256 } from "./validation.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DURABLE_REFERENCE_PATTERN = /^[a-z][a-z0-9-]{1,31}:[A-Za-z0-9._:@/-]{1,256}$/;
const CUTOVER_SURFACES = new Set(["auth", "billing", "session", "workspace", "upload", "knowledge", "memory"]);
const CUTOVER_KINDS = new Set(["create", "update", "delete"]);
const ALLOWED_TRANSITIONS: Readonly<Record<RuntimePhase, readonly RuntimePhase[]>> = {
  staged: ["verified"],
  verified: ["source-frozen"],
  "source-frozen": ["promoted"],
  promoted: ["accepted", "rollback-pending", "rolled-back"],
  "rollback-pending": ["rolled-back"],
  "rolled-back": [],
  accepted: [],
};

interface RuntimeTransitionContext {
  deltaCount: number;
  reconciled: boolean;
}

interface OpenEpochInput {
  epochId: string;
  migrationRunId: string;
  openedAt: string;
  sourceManifestSha256: string;
  targetManifestSha256: string;
}

export function transitionRuntimePhase(
  current: RuntimePhase,
  next: RuntimePhase,
  context: RuntimeTransitionContext,
): RuntimePhase {
  validateTransitionContext(context);
  if (!ALLOWED_TRANSITIONS[current].includes(next)) {
    throw new Error(`runtime phase transition ${current} -> ${next} is not allowed`);
  }
  validateRollbackTransition(current, next, context);
  return next;
}

function validateRollbackTransition(
  current: RuntimePhase,
  next: RuntimePhase,
  context: RuntimeTransitionContext,
): void {
  if (current === "promoted" && next === "rolled-back" && context.deltaCount > 0) {
    throw new Error("non-empty delta requires rollback-pending before rollback");
  }
  if (current === "promoted" && next === "rollback-pending" && context.deltaCount === 0) {
    throw new Error("empty delta must use direct rollback");
  }
  if (current === "rollback-pending" && next === "rolled-back" && !context.reconciled) {
    throw new Error("rollback requires completed reconciliation");
  }
}

export function openCutoverEpoch(input: OpenEpochInput): CutoverEpochRecord {
  assertUuid(input.epochId, "epochId");
  assertUuid(input.migrationRunId, "migrationRunId");
  assertIsoTimestamp(input.openedAt, "openedAt");
  assertSha256(input.sourceManifestSha256, "sourceManifestSha256");
  assertSha256(input.targetManifestSha256, "targetManifestSha256");
  return { ...input, nextSequence: 1, phase: "source-frozen", schemaVersion: 1 };
}

export function sealCutoverEpoch(epoch: CutoverEpochRecord, sealedAt: string): CutoverEpochRecord {
  if (epoch.sealedAt) throw new Error("cutover epoch is already sealed");
  assertIsoTimestamp(sealedAt, "sealedAt");
  if (Date.parse(sealedAt) < Date.parse(epoch.openedAt)) throw new Error("sealedAt cannot precede openedAt");
  return { ...epoch, sealedAt };
}

export function appendCutoverDelta(journal: CutoverJournal, entry: CutoverDeltaEntry): CutoverJournal {
  if (journal.epoch.sealedAt) throw new Error("cannot append to a sealed cutover epoch");
  validateDeltaEntry(journal.epoch, entry);
  if (journal.entries.some((existing) => existing.operationId === entry.operationId)) {
    throw new Error("cutover delta operationId must be unique");
  }
  return {
    epoch: { ...journal.epoch, nextSequence: journal.epoch.nextSequence + 1 },
    entries: [...journal.entries, { ...entry }],
  };
}

function validateTransitionContext(context: RuntimeTransitionContext): void {
  if (!Number.isSafeInteger(context.deltaCount) || context.deltaCount < 0) {
    throw new Error("deltaCount must be a non-negative safe integer");
  }
}

function validateDeltaEntry(epoch: CutoverEpochRecord, entry: CutoverDeltaEntry): void {
  validateDeltaIdentity(epoch, entry);
  validateDeltaTime(epoch, entry);
  validateDeltaDigests(entry);
  if (!DURABLE_REFERENCE_PATTERN.test(entry.durableReference)) {
    throw new Error("durableReference must be a bounded typed reference");
  }
}

function validateDeltaIdentity(epoch: CutoverEpochRecord, entry: CutoverDeltaEntry): void {
  if (entry.epochId !== epoch.epochId) throw new Error("cutover delta epochId mismatch");
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) throw new Error("cutover delta sequence is invalid");
  if (entry.sequence !== epoch.nextSequence) throw new Error("cutover delta sequence must be contiguous");
  if (!CUTOVER_SURFACES.has(entry.surface)) throw new Error("cutover delta surface is invalid");
  if (!CUTOVER_KINDS.has(entry.kind)) throw new Error("cutover delta kind is invalid");
  if (typeof entry.reversible !== "boolean") throw new Error("cutover delta reversible must be boolean");
  assertUuid(entry.operationId, "operationId");
}

function validateDeltaTime(epoch: CutoverEpochRecord, entry: CutoverDeltaEntry): void {
  assertIsoTimestamp(entry.occurredAt, "occurredAt");
  if (Date.parse(entry.occurredAt) < Date.parse(epoch.openedAt)) throw new Error("delta cannot precede the epoch");
}

function validateDeltaDigests(entry: CutoverDeltaEntry): void {
  assertSha256(entry.targetDigest, "targetDigest");
  assertSha256(entry.afterDigest, "afterDigest");
  if (entry.beforeDigest !== undefined) assertSha256(entry.beforeDigest, "beforeDigest");
}

function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}
