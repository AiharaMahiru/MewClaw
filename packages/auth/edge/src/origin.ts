import type { IncomingMessage } from "node:http";

import { constantTimeEqual } from "dsh-lark-auth";

export function trustedOrigin(req: IncomingMessage, origins: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) return origins.includes(origin);
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  return origins.some((item) => { try { return new URL(item).host === host; } catch { return false; } });
}

export function csrfValid(req: IncomingMessage, expected: string | undefined, origins: readonly string[]): boolean {
  if (!trustedOrigin(req, origins)) return false;
  const provided = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : "";
  return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

/**
 * 官方 Web 客户端不会添加产品自定义 CSRF header。对同源 RPC 仍要求
 * Origin/Host allowlist，并把双提交 cookie 转成内部 header；若客户端显式
 * 发送 header，则必须与 cookie 恒时相等。
 */
export function proxyCsrfValid(req: IncomingMessage, expected: string | undefined, origins: readonly string[]): boolean {
  if (!trustedOrigin(req, origins) || !expected) return false;
  const provided = typeof req.headers["x-csrf-token"] === "string" ? req.headers["x-csrf-token"] : undefined;
  return provided === undefined || constantTimeEqual(expected, provided);
}
