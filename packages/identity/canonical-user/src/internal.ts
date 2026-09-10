import { createHash } from "node:crypto";

import type {
  CanonicalUserId,
  IdentityNamespace,
  PrincipalResolution,
  UsageIdentitySource,
} from "./types.js";
import { CanonicalUserError } from "./types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_EXTERNAL_ID_LENGTH = 256;

export interface CommandTiming {
  occurredAt: string;
  completedAt: string;
}

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} 非法`);
}

export function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`${label} 必须是小写 UUID`);
}

export function assertExternalId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value !== value.trim()
    || value.length === 0 || value.length > MAX_EXTERNAL_ID_LENGTH || CONTROL_CHARS.test(value)) {
    invalid(`${label} 非法`);
  }
}

export function assertNamespace(namespace: unknown): asserts namespace is IdentityNamespace {
  assertRecord(namespace, "namespace");
  assertExternalId(namespace.tenantId, "tenantId");
  assertExternalId(namespace.botId, "botId");
  assertExternalId(namespace.deploymentId, "deploymentId");
}

export function assertExpectedVersion(value: unknown): void {
  if (value !== undefined
    && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) invalid("expectedVersion 非法");
}

export function assertUsageSource(source: unknown): asserts source is UsageIdentitySource {
  assertRecord(source, "source");
  if (source.kind === "web") {
    assertUuid(source.userId, "canonicalUserId");
    return;
  }
  if (source.kind === "feishu") {
    assertExternalId(source.openId, "openId");
    return;
  }
  invalid("source.kind 非法");
}

export function assertWebResolveMetadata(input: { eventId?: unknown; occurredAt?: unknown }): void {
  if (input.eventId !== undefined || input.occurredAt !== undefined) {
    invalid("Web resolve 不接受 eventId 或 occurredAt");
  }
}

export function resolveCommandTiming(value: unknown, now: () => Date): CommandTiming {
  const serverTime = now();
  const serverMillis = serverTime.getTime();
  if (!Number.isFinite(serverMillis)) throw new Error("canonical-user: server clock is invalid");
  const completedAt = serverTime.toISOString();
  if (value === undefined) return { occurredAt: completedAt, completedAt };
  const occurredAt = canonicalTimestamp(value);
  if (Date.parse(occurredAt) > serverMillis) invalid("occurredAt 晚于服务器时间");
  return { occurredAt, completedAt };
}

export function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") invalid("occurredAt 非法");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid("occurredAt 非法");
  return parsed.toISOString();
}

export function namespaceKey(namespace: IdentityNamespace): string {
  return [namespace.tenantId, namespace.botId, namespace.deploymentId].join("\0");
}

export function identityKey(namespace: IdentityNamespace, subject: string): string {
  return `${namespaceKey(namespace)}\0feishu\0${subject}`;
}

export function webKey(namespace: IdentityNamespace, canonicalUserId: CanonicalUserId): string {
  return `${namespaceKey(namespace)}\0web\0${canonicalUserId}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CommandDigestInput {
  operation: "ensure" | "bind" | "unbind";
  namespace: IdentityNamespace;
  subject: string;
  canonicalUserId: CanonicalUserId | null;
  expectedVersion?: number | undefined;
  occurredAt?: string | null;
}

export function commandDigest(input: CommandDigestInput): string {
  return sha256(JSON.stringify([
    input.operation,
    input.namespace.tenantId,
    input.namespace.botId,
    input.namespace.deploymentId,
    sha256(input.subject),
    input.canonicalUserId,
    input.expectedVersion ?? null,
    input.occurredAt ?? null,
  ]));
}

export function assertDigest(value: string, label: string): void {
  if (!DIGEST_PATTERN.test(value)) throw new Error(`canonical-user: PostgreSQL returned invalid ${label}`);
}

export function cloneNamespace(namespace: IdentityNamespace): IdentityNamespace {
  return { ...namespace };
}

export function resolution(
  principalId: PrincipalResolution["principalId"],
  canonicalUserId: CanonicalUserId | null,
  bindingVersion: number,
): PrincipalResolution {
  return { principalId, canonicalUserId, bindingVersion };
}

function invalid(message: string): never {
  throw new CanonicalUserError("INVALID_INPUT", `canonical-user: ${message}`);
}
