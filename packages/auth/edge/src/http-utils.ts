import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { readCookie } from "./cookies.js";

export function requestId(req: IncomingMessage): string { return typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"]!.slice(0, 128) : randomUUID(); }
export function clientIp(req: IncomingMessage): string { return (req.socket.remoteAddress || "unknown").slice(0, 128); }
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
