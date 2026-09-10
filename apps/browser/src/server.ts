import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { parseScope } from "dsh-lark-contracts";

import type { BrowserConfig } from "./config.js";
import { BrowserAppError, type BrowserErrorCode } from "./errors.js";
import type { BrowserAction, BrowserManager, BrowserOperation } from "./manager.js";

const OPERATIONS = new Set<BrowserOperation>(["open", "snapshot", "click", "type", "wait", "evaluate", "console", "network", "screenshot", "close"]);

export function createBrowserServer(config: BrowserConfig, manager: BrowserManager): Server {
  const server = createServer((req, res) => { void dispatch(config, manager, req, res); });
  server.on("connect", (_req, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"));
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"));
  return server;
}

async function dispatch(config: BrowserConfig, manager: BrowserManager, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!authorized(req, config.bearerToken)) return send(res, 401, { error: "BROWSER_FORBIDDEN" });
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/api/browser/action") return send(res, 404, { error: "BROWSER_NOT_FOUND" });
    if (req.method !== "POST") return send(res, 405, { error: "BROWSER_INVALID_INPUT" });
    const body = await readJson(req, config.maxRequestBytes);
    const parsed = parseScope(body.scope);
    if (!parsed.ok) throw new BrowserAppError("BROWSER_INVALID_INPUT");
    const operation = parseOperation(body.operation);
    const action: BrowserAction = {
      operation,
      ...optionalString(body, "workspace"),
      ...optionalString(body, "url"),
      ...optionalString(body, "selector"),
      ...optionalString(body, "text"),
      ...optionalString(body, "expression"),
      ...optionalString(body, "filename"),
      ...(body.milliseconds === undefined ? {} : { milliseconds: numberField(body.milliseconds) }),
    };
    const result = await manager.execute(parsed.value, action);
    send(res, 200, result);
  } catch (error) {
    const normalized = error instanceof BrowserAppError ? error : new BrowserAppError("BROWSER_UPSTREAM");
    send(res, statusFor(normalized.code), {
      error: { code: normalized.code, message: normalized.code, retryable: retryable(normalized.code) },
    });
  }
}

function authorized(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) throw new BrowserAppError("BROWSER_INVALID_INPUT");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new BrowserAppError("BROWSER_INVALID_INPUT"); }
}

function parseOperation(value: unknown): BrowserOperation {
  if (typeof value !== "string" || !OPERATIONS.has(value as BrowserOperation)) throw new BrowserAppError("BROWSER_INVALID_INPUT");
  return value as BrowserOperation;
}

function optionalString(body: Record<string, unknown>, key: keyof Omit<BrowserAction, "operation" | "milliseconds">): Partial<BrowserAction> {
  const value = body[key];
  if (value === undefined) return {};
  if (typeof value !== "string") throw new BrowserAppError("BROWSER_INVALID_INPUT");
  return { [key]: value };
}

function numberField(value: unknown): number {
  if (typeof value !== "number") throw new BrowserAppError("BROWSER_INVALID_INPUT");
  return value;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function statusFor(code: BrowserErrorCode): number {
  switch (code) {
    case "BROWSER_INVALID_INPUT": return 400;
    case "BROWSER_SCRIPT_ERROR": return 422;
    case "BROWSER_FORBIDDEN": return 403;
    case "BROWSER_NOT_OPEN":
    case "BROWSER_NOT_FOUND": return 404;
    case "BROWSER_CONFLICT": return 409;
    case "BROWSER_QUOTA": return 429;
    case "BROWSER_TIMEOUT": return 504;
    case "BROWSER_UNAVAILABLE": return 503;
    case "BROWSER_UPSTREAM": return 502;
  }
}

function retryable(code: BrowserErrorCode): boolean {
  return code === "BROWSER_TIMEOUT" || code === "BROWSER_UNAVAILABLE" || code === "BROWSER_UPSTREAM";
}
