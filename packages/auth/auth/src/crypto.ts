import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
const PASSWORD_N = 16_384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_KEY_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;

export function generateOpaqueToken(bytes = 32, source: (size: number) => Buffer = randomBytes): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 128) throw new Error("token size out of bounds");
  return source(bytes).toString("base64url");
}

export function hashOpaqueToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashMetadata(value: string | undefined): string | null {
  return value ? hashOpaqueToken(value) : null;
}

export async function hashPassword(password: string, source: (size: number) => Buffer = randomBytes): Promise<string> {
  const salt = source(PASSWORD_SALT_BYTES);
  const derived = await derive(password, salt, PASSWORD_KEY_BYTES, {
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", String(PASSWORD_N), String(PASSWORD_R), String(PASSWORD_P), salt.toString("base64url"), derived.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nText, rText, pText, saltText, expectedText] = encoded.split("$");
  if (algorithm !== "scrypt" || !nText || !rText || !pText || !saltText || !expectedText) return false;
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(expectedText, "base64url");
    const actual = await derive(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(password: string, salt: Buffer, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLocaleLowerCase("en-US");
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("INVALID_EMAIL");
  return email;
}

export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 256 || /^\s+$/.test(password)) throw new Error("INVALID_PASSWORD");
}
