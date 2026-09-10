/**
 * 管理面 HTTP 工具：JSON 应答、有界请求体读取、Bearer 恒定时间比较、
 * 静态面服务（SPA 回退 + 路径穿越防护）。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** JSON 应答（业务错误信封统一 {error: code}）。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string): void {
  sendJson(res, status, { error: code });
}

export function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { "cache-control": "no-store" });
  res.end();
}

/** 读取 JSON 请求体（有界；超限/非法 → 400）。 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const buffer = await readRawBody(req, maxBytes);
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid json body");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpInputError(400, "INVALID_REQUEST", "invalid json body");
  }
}

/** 读取原始请求体（有界；超限 → 413）。 */
export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    total += buffer.byteLength;
    if (total > maxBytes) throw new HttpInputError(413, "UPLOAD_TOO_LARGE", "request body exceeds the size limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export class HttpInputError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpInputError";
  }
}

/** Bearer 令牌恒定时间比较（长度不同直接拒绝，不泄露任何侧信道）。 */
export function constantTimeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function fileInfo(path: string) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : undefined;
  } catch {
    return undefined;
  }
}

/** 静态文件 + SPA 回退（无扩展名路径回退 index.html；穿越防护）。 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<void> {
  // 归一化根目录（配置可能混用正/反斜杠——process.cwd() + 字面路径）。
  const root = normalize(resolve(webRoot));
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(root, relative));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    sendError(res, 404, "NOT_FOUND");
    return;
  }
  const extension = extname(candidate);
  let file = extension ? candidate : join(candidate, "index.html");
  let info = await fileInfo(file);
  if (!info && !extension) {
    file = join(root, "index.html");
    info = await fileInfo(file);
  }
  if (!info) {
    sendError(res, 404, "NOT_FOUND");
    return;
  }
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] || "application/octet-stream",
    "content-length": info.size,
  });
  createReadStream(file).pipe(res);
}

/** 解析查询参数（URLSearchParams 语义）。 */
export function queryParams(req: IncomingMessage): URLSearchParams {
  const index = (req.url || "").indexOf("?");
  return new URLSearchParams(index >= 0 ? req.url!.slice(index + 1) : "");
}

/** 提取 pathname（不含查询串）。 */
export function pathnameOf(req: IncomingMessage): string {
  const url = req.url || "/";
  const index = url.indexOf("?");
  const raw = index >= 0 ? url.slice(0, index) : url;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
