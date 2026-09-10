import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { RUN_BODY_BYTES_LIMIT } from "./request.js";

export class HttpInputError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpInputError";
  }
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function writeInvalid(response: ServerResponse, error: HttpInputError): void {
  writeJson(response, error.status, { code: "INVALID_REQUEST", message: error.message });
}

export function writeNotFound(response: ServerResponse): void {
  writeJson(response, 404, { code: "NOT_FOUND" });
}

export function checkAuth(
  token: string | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  if (!token) return true;
  const header = request.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const tokenHash = createHash("sha256").update(token).digest();
  if (timingSafeEqual(suppliedHash, tokenHash)) return true;
  writeJson(response, 401, { code: "UNAUTHORIZED", message: "bearer token 不匹配" });
  return false;
}

export async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > RUN_BODY_BYTES_LIMIT) throw new HttpInputError(413, "请求体超出大小上限");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpInputError(400, "请求体不是合法 JSON");
  }
}

export function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}
