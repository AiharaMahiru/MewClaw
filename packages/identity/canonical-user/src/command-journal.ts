import {
  assertDigest,
  assertNamespace,
  assertUuid,
  canonicalTimestamp,
} from "./internal.js";
import type {
  BindingId,
  CanonicalMutationFailure,
  CanonicalMutationResult,
  CanonicalMutationSuccess,
  CanonicalUserId,
  CanonicalUserOutboxEvent,
  IdentityNamespace,
  PrincipalId,
  PrincipalResolution,
} from "./types.js";

export type StoredCommandResult =
  | { kind: "resolution"; result: PrincipalResolution }
  | { kind: "mutation"; result: CanonicalMutationResult };

const MUTATION_OUTCOMES = new Set(["bound", "unbound", "unchanged"]);
const EVENT_TYPES = new Set(["identity-bound", "identity-unbound"]);
const FAILURE_CODES = new Set([
  "EXPECTED_VERSION_MISMATCH",
  "IDENTITY_ALREADY_BOUND",
  "IDENTITY_NOT_BOUND",
  "CANONICAL_USER_MISMATCH",
  "EVENT_ID_CONFLICT",
  "INVALID_INPUT",
]);

export function storedResolution(result: PrincipalResolution): StoredCommandResult {
  return { kind: "resolution", result: cloneResolution(result) };
}

export function storedMutation(result: CanonicalMutationResult): StoredCommandResult {
  return { kind: "mutation", result: cloneMutation(result) };
}

export function parseStoredCommandResult(value: unknown): StoredCommandResult {
  try {
    const record = asRecord(typeof value === "string" ? JSON.parse(value) : value);
    if (record.kind === "resolution") return storedResolution(parseResolution(record.result));
    if (record.kind === "mutation") return storedMutation(parseMutation(record.result));
  } catch {
    // 持久化边界统一脱敏，避免数据库 detail 或损坏 JSON 外泄。
  }
  throw new Error("canonical-user: PostgreSQL returned invalid command result");
}

function parseMutation(value: unknown): CanonicalMutationResult {
  const record = asRecord(value);
  if (record.ok === true) return parseMutationSuccess(record);
  if (record.ok !== false || typeof record.code !== "string" || !FAILURE_CODES.has(record.code)) {
    throw new Error("invalid mutation result");
  }
  if (record.code === "EXPECTED_VERSION_MISMATCH") {
    return { ok: false, code: record.code, currentVersion: positiveInteger(record.currentVersion) };
  }
  return { ok: false, code: record.code } as CanonicalMutationFailure;
}

function parseMutationSuccess(record: Record<string, unknown>): CanonicalMutationSuccess {
  if (typeof record.outcome !== "string" || !MUTATION_OUTCOMES.has(record.outcome)) {
    throw new Error("invalid mutation outcome");
  }
  const resolution = parseResolution(record.resolution);
  const event = parseEvent(record.event);
  if (event.outcome !== record.outcome || !eventMatchesOutcome(event) || !sameResolution(resolution, event)) {
    throw new Error("inconsistent mutation result");
  }
  return {
    ok: true,
    outcome: record.outcome as CanonicalMutationSuccess["outcome"],
    resolution,
    event,
  };
}

function parseResolution(value: unknown): PrincipalResolution {
  const record = asRecord(value);
  const principalId = uuid(record.principalId, "principalId") as PrincipalId;
  const canonicalUserId = record.canonicalUserId === null
    ? null
    : uuid(record.canonicalUserId, "canonicalUserId") as CanonicalUserId;
  return { principalId, canonicalUserId, bindingVersion: positiveInteger(record.bindingVersion) };
}

function parseEvent(value: unknown): CanonicalUserOutboxEvent {
  const record = asRecord(value);
  if (typeof record.eventType !== "string" || !EVENT_TYPES.has(record.eventType)) throw new Error("invalid event type");
  if (typeof record.outcome !== "string" || !MUTATION_OUTCOMES.has(record.outcome)) throw new Error("invalid event outcome");
  const namespace = parseNamespace(record.namespace);
  const subjectDigest = string(record.subjectDigest);
  assertDigest(subjectDigest, "subject digest");
  return {
    eventId: uuid(record.eventId, "eventId"),
    eventType: record.eventType as CanonicalUserOutboxEvent["eventType"],
    outcome: record.outcome as CanonicalUserOutboxEvent["outcome"],
    namespace,
    bindingId: uuid(record.bindingId, "bindingId") as BindingId,
    principalId: uuid(record.principalId, "principalId") as PrincipalId,
    canonicalUserId: record.canonicalUserId === null ? null : uuid(record.canonicalUserId, "canonicalUserId") as CanonicalUserId,
    bindingVersion: positiveInteger(record.bindingVersion),
    subjectDigest,
    occurredAt: occurredAt(record.occurredAt),
  };
}

function parseNamespace(value: unknown): IdentityNamespace {
  const record = asRecord(value);
  const namespace = {
    tenantId: string(record.tenantId) as IdentityNamespace["tenantId"],
    botId: string(record.botId) as IdentityNamespace["botId"],
    deploymentId: string(record.deploymentId) as IdentityNamespace["deploymentId"],
  };
  assertNamespace(namespace);
  return namespace;
}

function sameResolution(resolution: PrincipalResolution, event: CanonicalUserOutboxEvent): boolean {
  return resolution.principalId === event.principalId
    && resolution.canonicalUserId === event.canonicalUserId
    && resolution.bindingVersion === event.bindingVersion;
}

function eventMatchesOutcome(event: CanonicalUserOutboxEvent): boolean {
  if (event.outcome === "unchanged") return true;
  return (event.eventType === "identity-bound" && event.outcome === "bound")
    || (event.eventType === "identity-unbound" && event.outcome === "unbound");
}

function cloneResolution(value: PrincipalResolution): PrincipalResolution {
  return { ...value };
}

function cloneMutation(value: CanonicalMutationResult): CanonicalMutationResult {
  return parseMutation(value);
}

function occurredAt(value: unknown): string {
  return canonicalTimestamp(string(value));
}

function uuid(value: unknown, label: string): string {
  const candidate = string(value);
  assertUuid(candidate, label);
  return candidate;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("invalid integer");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid string");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid object");
  return value as Record<string, unknown>;
}
