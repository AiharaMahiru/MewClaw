import type { CredentialImportDecision } from "./capability.js";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const NATIVE_SALT_BYTES = 16;
const NATIVE_KEY_BYTES = 32;
const DOORAGENT_SALT_TEXT_BYTES = 32;
const DOORAGENT_KEY_BYTES = 64;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const LOWER_HEX = /^[0-9a-f]+$/;

export type CredentialRejectionReason =
  | "UNSUPPORTED_FORMAT"
  | "SOURCE_NOT_ALLOWED"
  | "INVALID_PARAMETERS"
  | "INVALID_LENGTH"
  | "NON_CANONICAL_ENCODING";

export type InspectedImportCredential =
  | (Extract<CredentialImportDecision, { action: "reuse" }> & { normalizedEncoded: string })
  | Extract<CredentialImportDecision, { action: "reset_required" }>;

export function inspectImportCredential(input: {
  sourceSystem: string;
  encoded: string;
}): InspectedImportCredential {
  if (input.encoded.startsWith("scrypt$")) return inspectNative(input.encoded);
  if (input.encoded.startsWith("scrypt:")) {
    if (input.sourceSystem !== "dooragent") return rejected("SOURCE_NOT_ALLOWED");
    return inspectDoorAgent(input.encoded);
  }
  return rejected("UNSUPPORTED_FORMAT");
}

function inspectNative(encoded: string): InspectedImportCredential {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return rejected("UNSUPPORTED_FORMAT");
  if (parts[1] !== String(SCRYPT_N) || parts[2] !== String(SCRYPT_R) || parts[3] !== String(SCRYPT_P)) {
    return rejected("INVALID_PARAMETERS");
  }
  const salt = canonicalBase64url(parts[4]);
  const key = canonicalBase64url(parts[5]);
  if (!salt || !key) return rejected("NON_CANONICAL_ENCODING");
  if (salt.length !== NATIVE_SALT_BYTES || key.length !== NATIVE_KEY_BYTES) {
    return rejected("INVALID_LENGTH");
  }
  return { action: "reuse", algorithm: "scrypt", profile: "dsh-native", normalizedEncoded: encoded };
}

function inspectDoorAgent(encoded: string): InspectedImportCredential {
  const parts = encoded.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return rejected("UNSUPPORTED_FORMAT");
  const saltText = parts[1] ?? "";
  const keyHex = parts[2] ?? "";
  if (!LOWER_HEX.test(saltText) || !LOWER_HEX.test(keyHex)) return rejected("NON_CANONICAL_ENCODING");
  if (Buffer.byteLength(saltText, "ascii") !== DOORAGENT_SALT_TEXT_BYTES
    || keyHex.length !== DOORAGENT_KEY_BYTES * 2) return rejected("INVALID_LENGTH");
  const salt = Buffer.from(saltText, "ascii");
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== DOORAGENT_KEY_BYTES || key.toString("hex") !== keyHex) {
    return rejected("NON_CANONICAL_ENCODING");
  }
  const normalizedEncoded = [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
  return { action: "reuse", algorithm: "scrypt", profile: "dooragent-scrypt-v1", normalizedEncoded };
}

function canonicalBase64url(value: string | undefined): Buffer | undefined {
  if (!value || !BASE64URL.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function rejected(reason: CredentialRejectionReason): InspectedImportCredential {
  return { action: "reset_required", reason };
}
