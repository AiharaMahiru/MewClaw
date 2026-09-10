import { generateOpaqueToken } from "dsh-lark-auth";

export const CSRF_COOKIE = "dsh_csrf";
export const OAUTH_STATE_COOKIE = "dsh_oauth_state";

export function sessionCookieName(secure: boolean): string { return secure ? "__Host-dsh_session" : "dsh_session"; }

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    if (part.slice(0, index).trim() === name) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export function appendCookie(headers: string[], name: string, value: string, options: { httpOnly: boolean; secure: boolean; maxAge?: number }): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  headers.push(parts.join("; "));
}

export function newCsrfToken(): string { return generateOpaqueToken(24); }
