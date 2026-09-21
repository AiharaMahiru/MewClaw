import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";

import { hashOpaqueToken } from "dsh-lark-auth";
import type { AdminUserPatch, AuthUser, UserModelProfileDraft, UserModelProfilePatch } from "dsh-lark-auth";
import { FAVICON_PATH as BRAND_FAVICON_PATH, MANIFEST_PATH as BRAND_MANIFEST_PATH } from "dsh-lark-mewclaw-brand";
import { UrlPolicy, type Dispatcher } from "dsh-lark-url-policy";

import { DEFAULT_SESSION_TTL_MS, type AuthEdgeConfig } from "./config.js";
import { appendCookie, CSRF_COOKIE, newCsrfToken, OAUTH_STATE_COOKIE, sessionCookieName } from "./cookies.js";
import { clientIp, csrfToken, httpError, sendJson } from "./http-utils.js";
import { csrfValid, proxyCsrfValid } from "./origin.js";

export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const USER_MODEL_URL_POLICY = new UrlPolicy();

export function sendRpcFailure(res: ServerResponse, request: Record<string, unknown>, error: { code: string; message: string }): void {
  const rpcId = typeof request.rpcId === "string" ? request.rpcId : "";
  sendJson(res, 200, {
    type: "server-response",
    rpcId,
    result: { ok: false, error: { ...error, details: {} } },
  });
}

export function sessionCookies(config: AuthEdgeConfig, token: string): string[] { const cookies: string[] = []; appendCookie(cookies, sessionCookieName(config.sessionCookieSecure), token, { httpOnly: true, secure: config.sessionCookieSecure, maxAge: Math.floor((config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 1000) }); appendCookie(cookies, CSRF_COOKIE, newCsrfToken(), { httpOnly: false, secure: config.sessionCookieSecure }); return cookies; }
export function clearOAuthStateCookie(config: AuthEdgeConfig): string[] { const cookies: string[] = []; appendCookie(cookies, OAUTH_STATE_COOKIE, "", { httpOnly: true, secure: config.sessionCookieSecure, maxAge: 0 }); return cookies; }
export function publicUser(user: AuthUser): Record<string, unknown> { return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, defaultMode: user.defaultMode }; }
export function publicIdentity(identity: { provider: "feishu"; subject: string; unionId: string | null; createdAt: string }): Record<string, unknown> {
  return { provider: identity.provider, subject: identity.subject, unionId: identity.unionId, createdAt: identity.createdAt };
}
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "****";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, 4);
  return `${visible}${"*".repeat(Math.max(4, local.length - visible.length))}@${domain}`;
}
export function metadata(req: IncomingMessage) {
  const result: { requestId: string; ip?: string; userAgent?: string } = { requestId: typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"].slice(0, 128) : "edge" };
  const ip = clientIp(req);
  if (ip !== "unknown") result.ip = ip;
  if (typeof req.headers["user-agent"] === "string") result.userAgent = req.headers["user-agent"].slice(0, 512);
  return result;
}
export function clientKey(req: IncomingMessage): string { return clientIp(req); }
export function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}
export function loginKey(req: IncomingMessage, email: string): string { return `${clientKey(req)}:${hashOpaqueToken(email.trim().toLocaleLowerCase("en-US"))}`; }
export function isUnsafe(req: IncomingMessage): boolean { return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"; }
export function mutationAllowed(req: IncomingMessage, url: URL, origins: readonly string[]): boolean {
  if (url.pathname.startsWith("/auth/")) return csrfValid(req, csrfToken(req), origins);
  return proxyCsrfValid(req, csrfToken(req), origins);
}
export function string(value: unknown): string { return typeof value === "string" ? value : ""; }
export function userModelProfileId(pathname: string): string | undefined {
  const match = /^\/auth\/models\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/default)?$/iu.exec(pathname);
  return match?.[1]?.toLowerCase();
}
export function parseUserModelProfileDraft(body: Record<string, unknown>): UserModelProfileDraft {
  requireOnlyKeys(body, ["displayName", "baseUrl", "modelIds", "defaultModel", "apiKey"]);
  if (typeof body.displayName !== "string" || typeof body.baseUrl !== "string" || !Array.isArray(body.modelIds)
    || body.modelIds.some((model) => typeof model !== "string") || typeof body.defaultModel !== "string" || typeof body.apiKey !== "string") {
    throw httpError(400, "INVALID_REQUEST");
  }
  return { displayName: body.displayName, baseUrl: body.baseUrl, modelIds: [...body.modelIds] as string[], defaultModel: body.defaultModel, apiKey: body.apiKey };
}
export function parseUserModelProfilePatch(body: Record<string, unknown>): UserModelProfilePatch {
  requireOnlyKeys(body, ["expectedRevision", "displayName", "baseUrl", "modelIds", "defaultModel", "apiKey"]);
  const expectedRevision = parsePositiveInteger(body.expectedRevision);
  if (Object.keys(body).length === 1) throw httpError(400, "INVALID_REQUEST");
  if (body.displayName !== undefined && typeof body.displayName !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.baseUrl !== undefined && typeof body.baseUrl !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.modelIds !== undefined && (!Array.isArray(body.modelIds) || body.modelIds.some((model) => typeof model !== "string"))) throw httpError(400, "INVALID_REQUEST");
  if (body.defaultModel !== undefined && typeof body.defaultModel !== "string") throw httpError(400, "INVALID_REQUEST");
  if (body.apiKey !== undefined && typeof body.apiKey !== "string") throw httpError(400, "INVALID_REQUEST");
  return {
    expectedRevision,
    ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
    ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
    ...(Array.isArray(body.modelIds) ? { modelIds: [...body.modelIds] as string[] } : {}),
    ...(typeof body.defaultModel === "string" ? { defaultModel: body.defaultModel } : {}),
    ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
  };
}
export function parseUserModelProfileRevision(body: Record<string, unknown>): number {
  requireOnlyKeys(body, ["expectedRevision"]);
  return parsePositiveInteger(body.expectedRevision);
}
export function parsePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw httpError(400, "INVALID_REQUEST");
  return value;
}
export async function assertPublicUserModelUrl(value: string): Promise<void> {
  try {
    const url = await USER_MODEL_URL_POLICY.assertAllowed(value, true);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw httpError(400, "INVALID_USER_MODEL_BASE_URL");
  }
}

let userModelDispatcher: Dispatcher | undefined;
/** 用户私有模型出站共用的连接期守卫 dispatcher（进程级连接池，随进程生命周期）。 */
export function publicModelDispatcher(): Dispatcher {
  return (userModelDispatcher ??= USER_MODEL_URL_POLICY.createGuardedDispatcher());
}
export function requireOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw httpError(400, "INVALID_REQUEST");
}
export function parseIdentityRequest(body: Record<string, unknown>, admin: boolean): { provider: "feishu"; subject: string; userId?: string } {
  const allowed = admin ? ["provider", "subject", "userId"] : ["provider", "subject"];
  if (Object.keys(body).some((key) => !allowed.includes(key)) || (admin && !Object.hasOwn(body, "userId"))) throw httpError(400, "INVALID_REQUEST");
  if (body.provider !== "feishu" || typeof body.subject !== "string" || !body.subject.trim()) throw httpError(400, "INVALID_REQUEST");
  if (admin && (typeof body.userId !== "string" || !body.userId.trim())) throw httpError(400, "INVALID_REQUEST");
  return { provider: "feishu", subject: body.subject, ...(admin ? { userId: body.userId as string } : {}) };
}
export function parseJson(body: Buffer): Record<string, unknown> { const value: unknown = JSON.parse(body.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "INVALID_REQUEST"); return value as Record<string, unknown>; }
export function isJson(headers: Record<string, unknown>): boolean { const contentType = headers["content-type"]; return typeof contentType === "string" && contentType.includes("application/json"); }
export function isJsonHeader(contentType: string | string[] | undefined): boolean { return typeof contentType === "string" && contentType.toLowerCase().includes("application/json"); }
export function isHtml(headers: IncomingHttpHeaders): boolean {
  const contentType = headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().includes("text/html");
}
export function apiEndpoint(pathname: string): string | undefined { return pathname.startsWith("/api/") ? decodeURIComponent(pathname.slice("/api/".length)) : undefined; }
export function isWebUiSettingsBridge(endpoint: string | undefined): endpoint is "dsh-web-ui-settings/describe" | "dsh-web-ui-settings/mutate" {
  return endpoint === "dsh-web-ui-settings/describe" || endpoint === "dsh-web-ui-settings/mutate";
}
export function hasBody(req: IncomingMessage): boolean { return req.method === "POST" || req.method === "PUT" || req.method === "PATCH"; }
export function isAdminDataPath(pathname: string): boolean {
  return pathname === "/api/admin/summary"
    || pathname === "/api/admin/users"
    || pathname.startsWith("/api/admin/users/")
    || pathname === "/api/admin/sessions"
    || pathname.startsWith("/api/admin/sessions/");
}
export function parseAdminUserPatch(body: Record<string, unknown>): AdminUserPatch {
  const allowed = ["role", "status", "defaultMode"];
  if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) throw httpError(400, "INVALID_REQUEST");
  if (body.role !== undefined && body.role !== "admin" && body.role !== "user") throw httpError(400, "INVALID_REQUEST");
  if (body.status !== undefined && body.status !== "active" && body.status !== "disabled") throw httpError(400, "INVALID_REQUEST");
  if (body.defaultMode !== undefined && body.defaultMode !== "full" && body.defaultMode !== "lightweight") throw httpError(400, "INVALID_REQUEST");
  const role: AdminUserPatch["role"] = body.role === "admin" || body.role === "user" ? body.role : undefined;
  const status: AdminUserPatch["status"] = body.status === "active" || body.status === "disabled" ? body.status : undefined;
  const defaultMode: AdminUserPatch["defaultMode"] = body.defaultMode === "full" || body.defaultMode === "lightweight" ? body.defaultMode : undefined;
  return {
    ...(role ? { role } : {}),
    ...(status ? { status } : {}),
    ...(defaultMode ? { defaultMode } : {}),
  };
}
export function isPublicAssetRequest(req: IncomingMessage, url: URL): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  return url.pathname === "/favicon.ico"
    || url.pathname === "/favicon.svg"
    || url.pathname === "/manifest.webmanifest"
    || url.pathname === BRAND_FAVICON_PATH
    || url.pathname === BRAND_MANIFEST_PATH
    || url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/plugins/");
}
export function publicSharePrefix(pathname: string): string | undefined {
  const match = /^\/share\/([^/]+)(?:\/|$)/u.exec(pathname);
  return match ? `/share/${match[1]}` : undefined;
}
export function isInputError(code: unknown): boolean { return code === "INVALID_EMAIL" || code === "INVALID_PASSWORD" || code === "INVALID_VERIFICATION_CODE" || code === "INVALID_REQUEST" || code === "RESET_TOKEN_INVALID" || code === "OAUTH_INVALID" || code === "INVALID_FEISHU_OPEN_ID" || code === "INVALID_FEISHU_SESSION_ID" || code === "PAIRING_INVALID" || (typeof code === "string" && code.startsWith("INVALID_USER_MODEL_")); }
export function applySecurityHeaders(res: ServerResponse, requestUrl: string | undefined): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  const pathname = new URL(requestUrl ?? "/", "http://localhost").pathname;
  res.setHeader("x-frame-options", pathname.startsWith("/sidebar/html/") ? "SAMEORIGIN" : "DENY");
}
