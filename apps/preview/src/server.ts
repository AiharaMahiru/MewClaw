import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { parseScope } from "dsh-lark-contracts";
import type { PreviewErrorCode } from "dsh-preview";

import type { AppConfig } from "./config.js";
import { PreviewAppError } from "./errors.js";
import type { PreviewManager } from "./manager.js";
import { PreviewRequestTimeoutError, PreviewRequestTooLargeError, proxyHttp, proxyWebSocket } from "./proxy.js";

const CONTROL_ROUTES = new Set(["/api/preview/create", "/api/preview/list", "/api/preview/revoke"]);
type PreviewRequestRoute = "create" | "list" | "revoke" | "public" | "unknown";
export type PreviewFailureSink = (failure: { code: PreviewErrorCode; route: PreviewRequestRoute }) => void;

export function createPreviewServer(config: AppConfig, manager: PreviewManager, onFailure: PreviewFailureSink = () => undefined): Server {
  const limiter = new PreviewRequestLimiter(config.maxConcurrentRequests);
  const server = createServer((req, res) => { void dispatch(config, manager, limiter, onFailure, req, res); });
  server.on("upgrade", (req, socket, head) => { void upgrade(config, manager, limiter, onFailure, req, socket, head); });
  server.on("connect", (_req, socket) => socket.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n"));
  return server;
}

async function dispatch(config: AppConfig, manager: PreviewManager, limiter: PreviewRequestLimiter, onFailure: PreviewFailureSink, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (!authorized(req, config.workerToken)) return send(res, 401, { error: "PREVIEW_FORBIDDEN" });
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (CONTROL_ROUTES.has(url.pathname)) {
      if (req.method !== "POST") return send(res, 405, { error: "PREVIEW_INVALID_INPUT" });
      const body = await readJson(req, config.maxRequestBytes);
      const parsed = parseScope(body.scope);
      if (!parsed.ok) throw new PreviewAppError("PREVIEW_INVALID_INPUT");
      if (url.pathname === "/api/preview/create") {
        const descriptor = await manager.publish({
          scope: parsed.value,
          workspace: stringField(body.workspace),
          command: stringField(body.command),
          port: numberField(body.port),
          ...(body.ttlMinutes === undefined ? {} : { ttlMinutes: numberField(body.ttlMinutes) }),
        });
        return send(res, 201, descriptor);
      }
      if (url.pathname === "/api/preview/list") return send(res, 200, await manager.list(parsed.value));
      await manager.revoke(parsed.value, stringField(body.id));
      return send(res, 204);
    }
    const share = parseShare(url);
    if (!share) return send(res, 404, { error: "PREVIEW_NOT_FOUND" });
    if (req.method === "TRACE") return send(res, 405, { error: "PREVIEW_INVALID_INPUT" });
    const length = Number(req.headers["content-length"] || 0);
    if (Number.isFinite(length) && length > config.maxRequestBytes) return send(res, 413, { error: "PREVIEW_INVALID_INPUT" });
    const release = limiter.acquire();
    if (!release) return send(res, 503, { error: "PREVIEW_UNAVAILABLE" });
    try {
      await proxyHttp(manager, share.id, share.suffix, req, res, config.requestTimeoutMs, config.maxRequestBytes);
    } finally {
      release();
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const normalized = error instanceof PreviewAppError ? error : new PreviewAppError("PREVIEW_UNAVAILABLE");
    emitFailure(onFailure, { code: normalized.code, route: requestRoute(req.url) });
    const status = error instanceof PreviewRequestTooLargeError
      ? 413
      : error instanceof PreviewRequestTimeoutError ? 504 : statusFor(normalized.code);
    send(res, status, { error: normalized.code });
  }
}

export class PreviewRequestLimiter {
  #active = 0;

  constructor(private readonly limit: number) {}

  acquire(): (() => void) | undefined {
    if (this.#active >= this.limit) return undefined;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}

async function upgrade(config: AppConfig, manager: PreviewManager, limiter: PreviewRequestLimiter, onFailure: PreviewFailureSink, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  let release: (() => void) | undefined;
  try {
    if (!authorized(req, config.workerToken)) return rejectSocket(socket, 401);
    const share = parseShare(new URL(req.url || "/", "http://127.0.0.1"));
    if (!share) return rejectSocket(socket, 404);
    release = limiter.acquire();
    if (!release) return rejectSocket(socket, 503);
    socket.once("close", release);
    await proxyWebSocket(manager, share.id, share.suffix, req, socket, head);
  } catch (error) {
    release?.();
    const normalized = error instanceof PreviewAppError ? error : new PreviewAppError("PREVIEW_UPSTREAM");
    emitFailure(onFailure, { code: normalized.code, route: "public" });
    rejectSocket(socket, statusFor(normalized.code));
  }
}

function requestRoute(rawUrl: string | undefined): PreviewRequestRoute {
  let path: string;
  try { path = new URL(rawUrl || "/", "http://127.0.0.1").pathname; } catch { return "unknown"; }
  if (path === "/api/preview/create") return "create";
  if (path === "/api/preview/list") return "list";
  if (path === "/api/preview/revoke") return "revoke";
  return path.startsWith("/share/") ? "public" : "unknown";
}

function emitFailure(sink: PreviewFailureSink, failure: Parameters<PreviewFailureSink>[0]): void {
  try { sink(failure); } catch { /* 诊断消费者不得改变请求结果。 */ }
}

function parseShare(url: URL): { id: string; suffix: string } | undefined {
  const match = /^\/share\/([a-f0-9]{32})(\/.*)?$/.exec(url.pathname);
  return match?.[1] ? { id: match[1], suffix: `${match[2] || "/"}${url.search}` } : undefined;
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
    if (total > maxBytes) throw new PreviewAppError("PREVIEW_INVALID_INPUT");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new PreviewAppError("PREVIEW_INVALID_INPUT"); }
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new PreviewAppError("PREVIEW_INVALID_INPUT");
  return value;
}

function numberField(value: unknown): number {
  if (typeof value !== "number") throw new PreviewAppError("PREVIEW_INVALID_INPUT");
  return value;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    ...(payload ? { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) } : {}),
  });
  res.end(payload);
}

function statusFor(code: PreviewErrorCode): number {
  switch (code) {
    case "PREVIEW_INVALID_INPUT": return 400;
    case "PREVIEW_FORBIDDEN": return 403;
    case "PREVIEW_QUOTA": return 429;
    case "PREVIEW_NOT_FOUND": return 404;
    case "PREVIEW_UPSTREAM": return 502;
    case "PREVIEW_UNAVAILABLE": return 503;
  }
  const exhaustive: never = code;
  return exhaustive;
}

function rejectSocket(socket: Duplex, status: number): void {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\n\r\n`);
}
