import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_VERSION = 1;

export interface UserModelEncryptedSecret {
  keyVersion: number;
  apiKeyIv: string;
  apiKeyTag: string;
  apiKeyCiphertext: string;
}

export interface UserModelCipherBinding {
  userId: string;
  profileId: string;
  revision: number;
}

export class UserModelCryptoError extends Error {
  constructor(readonly code: "INVALID_KEY" | "CORRUPT" | "CLOSED") {
    super(`user model crypto: ${code}`);
    this.name = "UserModelCryptoError";
  }
}

/**
 * 用户私钥的最小 AEAD 封装。每次档案 revision 变化都重封装，以防止密文被
 * 跨用户、跨 Profile 或跨版本置换；调用方绝不能记录明文或本类的密文字段。
 */
export class UserModelCrypto {
  readonly #key: Buffer;
  #closed = false;

  constructor(keyMaterial: string) {
    this.#key = decodeKey(keyMaterial);
  }

  encrypt(apiKey: string, binding: UserModelCipherBinding): UserModelEncryptedSecret {
    this.assertOpen();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    cipher.setAAD(aad(binding));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    return {
      keyVersion: KEY_VERSION,
      apiKeyIv: iv.toString("base64url"),
      apiKeyTag: cipher.getAuthTag().toString("base64url"),
      apiKeyCiphertext: ciphertext.toString("base64url"),
    };
  }

  decrypt(secret: UserModelEncryptedSecret, binding: UserModelCipherBinding): string {
    this.assertOpen();
    if (secret.keyVersion !== KEY_VERSION) throw new UserModelCryptoError("CORRUPT");
    try {
      const iv = decodeEnvelopePart(secret.apiKeyIv, IV_BYTES);
      const tag = decodeEnvelopePart(secret.apiKeyTag, 16);
      const ciphertext = decodeEnvelopePart(secret.apiKeyCiphertext);
      const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      const result = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      if (!result) throw new Error("empty secret");
      return result;
    } catch (error) {
      if (error instanceof UserModelCryptoError) throw error;
      throw new UserModelCryptoError("CORRUPT");
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#key.fill(0);
  }

  private assertOpen(): void {
    if (this.#closed) throw new UserModelCryptoError("CLOSED");
  }
}

function aad(binding: UserModelCipherBinding): Buffer {
  if (!binding.userId || !binding.profileId || !Number.isSafeInteger(binding.revision) || binding.revision < 1) {
    throw new UserModelCryptoError("CORRUPT");
  }
  return Buffer.from(`dsh-user-model:v1\\0${binding.userId}\\0${binding.profileId}\\0${binding.revision}`, "utf8");
}

function decodeKey(value: string): Buffer {
  const normalized = value.trim();
  if (!normalized || /\s/.test(normalized)) throw new UserModelCryptoError("INVALID_KEY");
  const encoding = /^[A-Za-z0-9_-]{43}$/.test(normalized) ? "base64url" : "base64";
  let decoded: Buffer;
  try { decoded = Buffer.from(normalized, encoding); } catch { throw new UserModelCryptoError("INVALID_KEY"); }
  if (decoded.length !== KEY_BYTES) throw new UserModelCryptoError("INVALID_KEY");
  const canonical = encoding === "base64url" ? decoded.toString("base64url") : decoded.toString("base64");
  if (canonical !== normalized) throw new UserModelCryptoError("INVALID_KEY");
  return decoded;
}

function decodeEnvelopePart(value: string, exactLength?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new UserModelCryptoError("CORRUPT");
  const decoded = Buffer.from(value, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== value || (exactLength !== undefined && decoded.length !== exactLength)) {
    throw new UserModelCryptoError("CORRUPT");
  }
  return decoded;
}
