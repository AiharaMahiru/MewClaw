import { scryptSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./crypto.js";
import { inspectImportCredential } from "./credential-policy.js";

const PASSWORD = "correct horse battery staple";
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DOORAGENT_SALT_HEX = "00112233445566778899aabbccddeeff";

describe("inspectImportCredential", () => {
  it("accepts only the canonical dsh-native profile", async () => {
    const encoded = await hashPassword(PASSWORD, () => Buffer.alloc(16, 7));
    const decision = inspectImportCredential({ sourceSystem: "dsh", encoded });

    expect(decision).toEqual({
      action: "reuse",
      algorithm: "scrypt",
      profile: "dsh-native",
      normalizedEncoded: encoded,
    });
    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded)).resolves.toBe(false);
  });

  it("converts the exact DoorAgent v1 shape using the ASCII hex salt", async () => {
    const raw = dooragentCredential(PASSWORD);
    const decision = inspectImportCredential({ sourceSystem: "dooragent", encoded: raw });

    expect(decision.action).toBe("reuse");
    if (decision.action !== "reuse") throw new Error("expected reusable credential");
    expect(decision.profile).toBe("dooragent-scrypt-v1");
    expect(Buffer.from(decision.normalizedEncoded.split("$")[4]!, "base64url").toString("ascii"))
      .toBe(DOORAGENT_SALT_HEX);
    await expect(verifyPassword(PASSWORD, decision.normalizedEncoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", decision.normalizedEncoded)).resolves.toBe(false);
  });

  it.each([
    ["other source", "external", dooragentCredential(PASSWORD)],
    ["uppercase salt", "dooragent", dooragentCredential(PASSWORD).replace(DOORAGENT_SALT_HEX, DOORAGENT_SALT_HEX.toUpperCase())],
    ["short salt", "dooragent", `scrypt:${DOORAGENT_SALT_HEX.slice(2)}:${"a".repeat(128)}`],
    ["short key", "dooragent", `scrypt:${DOORAGENT_SALT_HEX}:${"a".repeat(126)}`],
    ["native 64-byte key", "dsh", nativeCredential(16, 64)],
    ["native 32-byte salt", "dsh", nativeCredential(32, 32)],
    ["padded base64url", "dsh", `${nativeCredential(16, 32)}=`],
  ])("rejects %s", (_label, sourceSystem, encoded) => {
    expect(inspectImportCredential({ sourceSystem, encoded }).action).toBe("reset_required");
  });
});

function dooragentCredential(password: string): string {
  const derived = scryptSync(password, DOORAGENT_SALT_HEX, 64, SCRYPT_OPTIONS);
  return `scrypt:${DOORAGENT_SALT_HEX}:${derived.toString("hex")}`;
}

function nativeCredential(saltBytes: number, keyBytes: number): string {
  return `scrypt$16384$8$1$${Buffer.alloc(saltBytes, 1).toString("base64url")}$${Buffer.alloc(keyBytes, 2).toString("base64url")}`;
}
