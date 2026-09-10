import { createHash } from "node:crypto";

import {
  AuthImportError,
  type AuthCredentialSyncInput,
  type AuthImportSource,
} from "./capability.js";
import { inspectImportCredential } from "./credential-policy.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_TEXT_LENGTH = 256;

export interface CredentialSyncDigestInput {
  source: AuthImportSource;
  snapshotDigest: string;
  targetUserId: string;
  expectedRole: "admin" | "user";
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  credentialDigest: string;
  rollbackSnapshotRef: string;
}

export interface PreparedCredentialSync {
  normalizedEncoded: string;
  payloadDigest: string;
  snapshotKey: string;
}

export function prepareCredentialSync(input: AuthCredentialSyncInput): PreparedCredentialSync {
  validateCredentialSyncFields(input);
  if (typeof input.sourceCredential !== "string" || !input.sourceCredential) {
    throw new AuthImportError("CREDENTIAL_SOURCE_INVALID");
  }
  const inspected = inspectImportCredential({ sourceSystem: "dooragent", encoded: input.sourceCredential });
  if (inspected.action !== "reuse" || inspected.profile !== "dooragent-scrypt-v1") {
    throw new AuthImportError("CREDENTIAL_SOURCE_INVALID");
  }
  const expectedDigest = credentialSyncCredentialDigest({
    ...input,
    normalizedEncoded: inspected.normalizedEncoded,
  });
  if (expectedDigest !== input.credentialDigest) {
    throw new AuthImportError("SOURCE_DIGEST_MISMATCH");
  }
  const payloadDigest = credentialSyncPayloadDigest(input);
  return {
    normalizedEncoded: inspected.normalizedEncoded,
    payloadDigest,
    snapshotKey: createHash("sha256").update(`credential-sync\0${payloadDigest}`).digest("hex"),
  };
}

export function credentialSyncCredentialDigest(input: {
  source: AuthImportSource;
  snapshotDigest: string;
  targetUserId: string;
  expectedRole: "admin" | "user";
  expectedDefaultMode: "full" | "lightweight";
  expectedStatus: "active";
  normalizedEncoded: string;
}): string {
  return digest({
    source: sourceFields(input.source),
    snapshotDigest: input.snapshotDigest,
    targetUserId: input.targetUserId,
    expectedRole: input.expectedRole,
    expectedDefaultMode: input.expectedDefaultMode,
    expectedStatus: input.expectedStatus,
    normalizedEncoded: input.normalizedEncoded,
  });
}

export function credentialSyncPayloadDigest(input: CredentialSyncDigestInput): string {
  return digest({
    source: sourceFields(input.source),
    snapshotDigest: input.snapshotDigest,
    targetUserId: input.targetUserId,
    expectedRole: input.expectedRole,
    expectedDefaultMode: input.expectedDefaultMode,
    expectedStatus: input.expectedStatus,
    credentialDigest: input.credentialDigest,
    rollbackSnapshotRef: input.rollbackSnapshotRef,
  });
}

export function validateCredentialSyncApproval(input: CredentialSyncDigestInput & {
  operator?: { userId?: string };
}): void {
  validateCredentialSyncFields(input);
}

function validateCredentialSyncFields(input: CredentialSyncDigestInput): void {
  if (input.source.sourceSystem !== "dooragent" || input.source.sourceType !== "credential") {
    throw new AuthImportError("CREDENTIAL_SOURCE_INVALID");
  }
  requireText(input.source.sourceId);
  requireText(input.targetUserId);
  requireText(input.rollbackSnapshotRef);
  if (!SHA256_HEX.test(input.source.sourceDigest)
    || !SHA256_HEX.test(input.snapshotDigest ?? "")
    || !SHA256_HEX.test(input.credentialDigest)) {
    throw new AuthImportError("IMPORT_INPUT_INVALID");
  }
  if (input.expectedRole === "admin" && input.expectedDefaultMode !== "full") {
    throw new AuthImportError("IMPORT_INPUT_INVALID");
  }
  if (input.expectedRole === "user" && input.expectedDefaultMode !== "lightweight") {
    throw new AuthImportError("IMPORT_INPUT_INVALID");
  }
  if (input.expectedStatus !== "active") throw new AuthImportError("IMPORT_INPUT_INVALID");
}

function sourceFields(source: AuthImportSource): Record<string, string> {
  return {
    sourceSystem: source.sourceSystem,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceDigest: source.sourceDigest,
  };
}

function requireText(value: unknown): void {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT_LENGTH || /\s/.test(value)) {
    throw new AuthImportError("IMPORT_INPUT_INVALID");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
