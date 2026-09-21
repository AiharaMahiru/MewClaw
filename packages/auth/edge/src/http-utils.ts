import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readCookie } from "./cookies.js";

export function requestId(req: IncomingMessage): string { return typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"]!.slice(0, 128) : randomUUID(); }

/**
 * 真实客户端地址：Auth Edge 只监听 loopback，TCP 对端恒为本机反代。
 * 仅当对端是 loopback 时采信代理注入的地址头——生产 nginx 以
 * `X-Real-IP $remote_addr` 覆盖赋值（客户端无法伪造），X-Forwarded-For
 * 兼容追加语义、取最末一跳。直连对端不是 loopback 时忽略全部转发头，
 * 避免服务被意外直接暴露时地址可伪造。
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress;
  if (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1") {
    const real = req.headers["x-real-ip"];
    if (typeof real === "string" && real.trim()) return real.trim().slice(0, 128);
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded ?? "").split(",").pop()?.trim();
    if (last) return last.slice(0, 128);
  }
  return (peer || "unknown").slice(0, 128);
}
export function userAgent(req: IncomingMessage): string | undefined { return typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 512) : undefined; }

export async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const buffer = await readBody(req, maxBytes);
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw httpError(400, "INVALID_REQUEST"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "INVALID_REQUEST");
  return value as Record<string, unknown>;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const current = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += current.byteLength;
    if (size > maxBytes) throw httpError(413, "REQUEST_TOO_LARGE");
    chunks.push(current);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, cookies: string[] = []): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end(payload);
}

export function sendHtml(res: ServerResponse, status: number, html: string, cookies: string[] = []): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) });
  res.end(html);
}

export function sendError(res: ServerResponse, status: number, error: string): void { sendJson(res, status, { error }); }

export function httpError(status: number, code: string): Error & { status: number; code: string } { const error = new Error(code) as Error & { status: number; code: string }; error.status = status; error.code = code; return error; }

export function sessionToken(req: IncomingMessage, secure: boolean): string | undefined { return readCookie(req.headers.cookie, secure ? "__Host-dsh_session" : "dsh_session"); }

export function csrfToken(req: IncomingMessage): string | undefined { return readCookie(req.headers.cookie, "dsh_csrf"); }
