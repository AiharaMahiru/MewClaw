import { scryptSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { AuthCredentialSyncInput, AuthImportSource } from "./capability.js";
import { credentialSyncCredentialDigest, prepareCredentialSync, validateCredentialSyncApproval } from "./credential-sync.js";
import { DefaultAuthCapability, type AuthImportStore } from "./import-service.js";

const SOURCE_DIGEST = "a".repeat(64);
const SNAPSHOT_DIGEST = "b".repeat(64);
const RAW = dooragentCredential("correct horse battery staple");

describe("credential sync contract", () => {
  it("normalizes only DoorAgent credentials and keeps raw material out of the digest", () => {
    const input = validInput();
    const prepared = prepareCredentialSync(input);

    expect(prepared.normalizedEncoded).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(prepared.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.payloadDigest).not.toContain(RAW);
    expect(prepared.snapshotKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["wrong source system", { sourceSystem: "external" }],
    ["wrong source type", { sourceType: "user" }],
  ])("rejects %s", (_label, patch) => {
    const input = { ...validInput(), source: { ...validInput().source, ...patch } } as AuthCredentialSyncInput;
    expect(() => prepareCredentialSync(input)).toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_SOURCE_INVALID" }),
    );
  });

  it("rejects a changed credential after approval digest creation", () => {
    const input = validInput();
    input.sourceCredential = dooragentCredential("a different password");
    expect(() => prepareCredentialSync(input)).toThrowError(
      expect.objectContaining({ code: "SOURCE_DIGEST_MISMATCH" }),
    );
  });

  it("allows approval binding for a store-verified self no-op", () => {
    expect(() => validateCredentialSyncApproval({
      ...validInput(),
      operator: { userId: "target-user" },
    })).not.toThrow();
  });

  it("fails closed before touching the store without an existing rollback provider", async () => {
    const syncCredential = vi.fn();
    const capability = new DefaultAuthCapability({ syncCredential } as unknown as AuthImportStore);

    await expect(capability.syncCredential(validInput())).rejects.toThrowError(
      expect.objectContaining({ code: "CREDENTIAL_ROLLBACK_UNAVAILABLE" }),
    );
    expect(syncCredential).not.toHaveBeenCalled();
  });
});

function validInput(): AuthCredentialSyncInput {
  const source: AuthImportSource = {
    sourceSystem: "dooragent",
    sourceType: "credential",
    sourceId: "source-user-1",
    sourceDigest: SOURCE_DIGEST,
  };
  const base = {
    scope: {
      tenantId: "tenant",
      botId: "bot",
      deploymentId: "deployment",
      userId: "operator-user",
      conversationId: "migration",
    },
    operator: { userId: "operator-user", sessionId: "admin-session", requestId: "request" },
    runId: "sync-run",
    planId: "sync-plan",
    snapshotDigest: SNAPSHOT_DIGEST,
    source,
    approvalRef: "approval-ref",
    cutoverEpochId: "cutover-1",
    targetUserId: "target-user",
    expectedRole: "user" as const,
    expectedDefaultMode: "lightweight" as const,
    expectedStatus: "active" as const,
    sourceCredential: RAW,
    rollbackSnapshotRef: "vault:dsh/credential-sync/source-user-1",
  } as Omit<AuthCredentialSyncInput, "credentialDigest">;
  const normalizedEncoded = prepareNormalized(RAW);
  return {
    ...base,
    credentialDigest: credentialSyncCredentialDigest({
      source,
      snapshotDigest: SNAPSHOT_DIGEST,
      targetUserId: base.targetUserId,
      expectedRole: base.expectedRole,
      expectedDefaultMode: base.expectedDefaultMode,
      expectedStatus: base.expectedStatus,
      normalizedEncoded,
    }),
  };
}

function prepareNormalized(encoded: string): string {
  const parts = encoded.split(":");
  return ["scrypt", "16384", "8", "1", Buffer.from(parts[1]!, "ascii").toString("base64url"), Buffer.from(parts[2]!, "hex").toString("base64url")].join("$");
}

function dooragentCredential(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  const derived = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
