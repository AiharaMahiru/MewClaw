import { describe, expect, it } from "vitest";

import { UserModelCrypto } from "./user-model-crypto.js";

const KEY = Buffer.alloc(32, 23).toString("base64url");
const binding = { userId: "user-a", profileId: "profile-a", revision: 1 };

describe("UserModelCrypto", () => {
  it("使用绑定到用户、Profile 和 revision 的 AES-256-GCM 封装密钥", () => {
    const crypto = new UserModelCrypto(KEY);
    const encrypted = crypto.encrypt("secret-key-never-returned", binding);

    expect(JSON.stringify(encrypted)).not.toContain("secret-key-never-returned");
    expect(crypto.decrypt(encrypted, binding)).toBe("secret-key-never-returned");
    expectCode(() => crypto.decrypt(encrypted, { ...binding, userId: "user-b" }), "CORRUPT");
    expectCode(() => crypto.decrypt(encrypted, { ...binding, profileId: "profile-b" }), "CORRUPT");
    expectCode(() => crypto.decrypt(encrypted, { ...binding, revision: 2 }), "CORRUPT");
    crypto.close();
  });

  it("拒绝篡改、无效主密钥与关闭后的解密", () => {
    expectCode(() => new UserModelCrypto("short"), "INVALID_KEY");
    const crypto = new UserModelCrypto(KEY);
    const encrypted = crypto.encrypt("secret-key", binding);
    expectCode(() => crypto.decrypt({ ...encrypted, apiKeyTag: encrypted.apiKeyTag.slice(1) }, binding), "CORRUPT");
    crypto.close();
    expectCode(() => crypto.decrypt(encrypted, binding), "CLOSED");
  });
});

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}
