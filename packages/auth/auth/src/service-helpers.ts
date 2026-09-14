import { hashOpaqueToken, normalizeEmail } from "./crypto.js";
import type {
  AdminSessionSummary,
  AuthSession,
  AuthStore,
  AuthUser,
  FeishuProfile,
} from "./types.js";

const VERIFICATION_CODE_LENGTH = 6;

export function nowIso(now: number): string { return new Date(now).toISOString(); }
export function isoAfter(now: number, durationMs: number): string { return new Date(now + durationMs).toISOString(); }
export function adminSessionSummary(session: AuthSession, user: AuthUser): AdminSessionSummary {
  return {
    id: session.id,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    revokedAt: session.revokedAt,
  };
}
export function generateVerificationCode(source: (size: number) => Buffer): string {
  const bytes = source(4);
  const value = bytes.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(VERIFICATION_CODE_LENGTH, "0");
}
export function normalizeVerificationCode(value: string): string {
  const code = value.trim();
  if (!new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`).test(code)) throw new Error("INVALID_VERIFICATION_CODE");
  return code;
}
export function hashVerificationCode(userId: string, code: string): string { return hashOpaqueToken(`${userId}:${code}`); }
export function normalizeDisplayName(value: string, email: string): string { const name = value.trim().slice(0, 120); return name || email.split("@")[0] || "用户"; }
export function normalizeFeishuOpenId(value: string): string {
  const openId = value.trim();
  if (!openId || openId.length > 256 || /[\u0000-\u001f\u007f]/.test(openId)) throw new Error("INVALID_FEISHU_OPEN_ID");
  return openId;
}
export function normalizeFeishuSessionId(value: string): string {
  const sessionId = value.trim();
  if (!/^session-[0-9a-f]{64}(?::[0-9]+)?$/.test(sessionId)) throw new Error("INVALID_FEISHU_SESSION_ID");
  return sessionId;
}
export function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505"); }
export function assertUnreachable(value: never): never { throw new Error(`UNREACHABLE_AUTH_STATE:${JSON.stringify(value)}`); }
export function mailDeliveryError(cause: unknown): Error & { code: "MAIL_DELIVERY_FAILED" } {
  const error = new Error("MAIL_DELIVERY_FAILED", { cause }) as Error & { code: "MAIL_DELIVERY_FAILED" };
  error.code = "MAIL_DELIVERY_FAILED";
  return error;
}
export function normalizeFeishuProfile(profile: FeishuProfile): FeishuProfile | undefined {
  const openId = profile.openId.trim();
  if (!openId) return undefined;
  const unionId = profile.unionId?.trim();
  const email = profile.email?.trim();
  const name = profile.name?.trim();
  return { openId, ...(unionId ? { unionId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}) };
}
export function assertFeishuIdentityConsistency(existing: AuthUserIdentity | undefined, unionExisting: AuthUserIdentity | undefined, unionId: string | undefined): void {
  if (existing && unionExisting && existing.userId !== unionExisting.userId) throw new Error("FEISHU_IDENTITY_CONFLICT");
  if (existing && unionId && existing.unionId && existing.unionId !== unionId) throw new Error("FEISHU_IDENTITY_CONFLICT");
  if (unionExisting && unionId && unionExisting.unionId !== unionId) throw new Error("FEISHU_IDENTITY_CONFLICT");
}
export function normalizedFeishuEmail(email: string | undefined, openId: string): string {
  if (email) {
    try { return normalizeEmail(email); } catch { /* provider email 不满足本地格式时使用不可登录的占位地址。 */ }
  }
  return `feishu-${hashOpaqueToken(openId).slice(0, 24)}@invalid.local`;
}

type AuthUserIdentity = Awaited<ReturnType<AuthStore["findIdentity"]>>;
