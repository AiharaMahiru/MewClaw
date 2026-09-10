import { Agent, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import { finished } from "node:stream/promises";

import { PreviewAppError } from "./errors.js";
import type { PreviewManager } from "./manager.js";

const MAX_HTML_BYTES = 16 * 1024 * 1024;
const DROP_REQUEST_HEADERS = new Set([
  "authorization", "cookie", "proxy-authorization", "proxy-authenticate",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
  "content-length", "accept-encoding", "connection", "upgrade",
]);
const DROP_RESPONSE_HEADERS = new Set([
  "content-security-policy", "content-security-policy-report-only", "strict-transport-security",
  "proxy-authenticate", "proxy-authorization", "connection", "keep-alive",
  "transfer-encoding", "upgrade", "trailer",
]);

export class PreviewRequestTooLargeError extends PreviewAppError {
  constructor() { super("PREVIEW_INVALID_INPUT", "请求体超过 Preview 上限"); }
}

export class PreviewRequestTimeoutError extends PreviewAppError {
  constructor() { super("PREVIEW_UPSTREAM", "用户服务响应超时"); }
}

/** HTTP 由 Node 解析，upstream chunked framing 不会再次写入 ServerResponse。 */
export async function proxyHttp(
  manager: PreviewManager,
  id: string,
  suffix: string,
  req: IncomingMessage,
  res: ServerResponse,
  requestTimeoutMs: number,
  maxRequestBytes: number,
): Promise<void> {
  const target = await manager.resolvePublic(id);
  const child = target.bridge();
  const connection = new ChildProcessDuplex(child);
  connection.on("error", () => undefined);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => connection;
  let upstream: ClientRequest;
  const response = new Promise<void>((resolvePromise, reject) => {
    upstream = httpRequest({
      method: req.method,
      host: "preview.internal",
      port: target.descriptor.port,
      path: normalizeSuffix(suffix),
      headers: filterRequestHeaders(req.headers, id),
      agent,
    }, (upstreamResponse) => {
      upstream.setTimeout(0);
      void forwardResponse(upstreamResponse, res, id).then(resolvePromise, reject);
    });
    upstream.setTimeout(requestTimeoutMs, () => upstream.destroy(new PreviewRequestTimeoutError()));
    upstream.once("error", reject);
  });
  try {
    await Promise.all([
      response,
      forwardRequestBody(req, upstream!, maxRequestBytes),
    ]);
  } catch (error) {
    connection.destroy();
    if (error instanceof PreviewRequestTooLargeError || error instanceof PreviewRequestTimeoutError) throw error;
    if (!res.headersSent) throw new PreviewAppError("PREVIEW_UPSTREAM");
    res.destroy();
  }
}

export async function proxyWebSocket(
  manager: PreviewManager,
  id: string,
  suffix: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const target = await manager.resolvePublic(id);
  const child = target.bridge();
  child.stderr.resume();
  child.stdin.write(serializeWebSocketRequest(req, suffix, id));
  if (head.length > 0) child.stdin.write(head);
  child.stdout.pipe(socket);
  socket.pipe(child.stdin);
  const close = () => child.kill("SIGKILL");
  socket.once("close", close);
  child.once("close", () => socket.destroy());
  child.once("error", () => socket.destroy());
}

export function filterRequestHeaders(headers: IncomingHttpHeaders, id: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || DROP_REQUEST_HEADERS.has(lower) || lower.startsWith("x-dsh-")) continue;
    result[lower] = value;
  }
  result.host = "127.0.0.1";
  result.connection = "close";
  result["x-forwarded-prefix"] = `/share/${id}`;
  return result;
}

export function rewriteResponseHeaders(
  headers: readonly [string, string][],
  id: string,
  html = false,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, original] of headers) {
    const lower = name.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(lower) || lower.startsWith("x-dsh-") || (html && lower === "content-length")) continue;
    let value = original;
    if (lower === "location") value = rewriteLocation(value, id);
    if (lower === "set-cookie") value = rewriteCookiePath(value, id);
    const existing = result[lower];
    result[lower] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return result;
}

export async function forwardRequestBody(
  source: AsyncIterable<unknown>,
  sink: RequestBodySink,
  maxBytes: number,
): Promise<void> {
  let total = 0;
  try {
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) throw new PreviewRequestTooLargeError();
      if (!sink.write(buffer)) await waitForDrain(sink);
    }
    sink.end();
  } catch (error) {
    sink.destroy(error as Error);
    throw error;
  }
}

interface RequestBodySink {
  write(chunk: Buffer): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  once(event: "drain" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "drain" | "error", listener: (...args: unknown[]) => void): unknown;
}

function waitForDrain(sink: RequestBodySink): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const drained = (): void => {
      sink.off("error", failed);
      resolvePromise();
    };
    const failed = (error: unknown): void => {
      sink.off("drain", drained);
      reject(error);
    };
    sink.once("drain", drained);
    sink.once("error", failed);
  });
}

export function rewriteHtml(input: string, id: string): string {
  const prefix = `/share/${id}`;
  const attributes = input.replace(
    /(\b(?:src|href|action)\s*=\s*["'])\/(?!\/)/gi,
    `$1${prefix}/`,
  );
  const adapter = `<base href="${prefix}/">`;
  const head = /<head(?:\s[^>]*)?>/i.exec(attributes);
  if (head?.index !== undefined) {
    const offset = head.index + head[0].length;
    return `${attributes.slice(0, offset)}${adapter}${attributes.slice(offset)}`;
  }
  return `${adapter}${attributes}`;
}

async function forwardResponse(response: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  const html = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
  const headers = rewriteResponseHeaders(rawHeaderPairs(response.rawHeaders), id, html);
  if (!html) {
    res.writeHead(response.statusCode || 502, headers);
    response.pipe(res);
    await finished(res, { cleanup: true });
    return;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_HTML_BYTES) throw new PreviewAppError("PREVIEW_UPSTREAM", "HTML 响应超过重写上限");
    chunks.push(buffer);
  }
  const body = Buffer.from(rewriteHtml(Buffer.concat(chunks).toString("utf8"), id));
  headers["content-length"] = String(body.length);
  res.writeHead(response.statusCode || 502, headers);
  res.end(body);
}

function serializeWebSocketRequest(req: IncomingMessage, suffix: string, id: string): string {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === "authorization" || lower === "cookie"
      || lower === "proxy-authorization" || lower.startsWith("x-dsh-")) continue;
    headers[lower] = value;
  }
  headers.host = "127.0.0.1";
  headers["x-forwarded-prefix"] = `/share/${id}`;
  const lines = [`${req.method || "GET"} ${normalizeSuffix(suffix)} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

class ChildProcessDuplex extends Duplex {
  #timeout: NodeJS.Timeout | undefined;
  #timeoutMs = 0;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      this.#refreshTimeout();
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.once("end", () => this.push(null));
    child.once("error", (error) => this.destroy(error));
    child.once("close", (code) => {
      if (code && !this.destroyed) this.destroy(new Error("preview bridge closed"));
    });
  }

  override _read(): void { this.child.stdout.resume(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#refreshTimeout();
    this.child.stdin.write(chunk, callback);
  }
  override _final(callback: (error?: Error | null) => void): void { this.child.stdin.end(callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.child.kill("SIGKILL");
    callback(error);
  }

  setTimeout(timeout: number, callback?: () => void): this {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeoutMs = timeout;
    if (timeout > 0) {
      this.#timeout = setTimeout(() => {
        this.#timeout = undefined;
        this.emit("timeout");
      }, timeout);
      this.#timeout.unref();
    }
    if (callback) this.once("timeout", callback);
    return this;
  }

  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  ref(): this { this.#timeout?.ref(); return this; }
  unref(): this { this.#timeout?.unref(); return this; }

  #refreshTimeout(): void {
    if (this.#timeout && this.#timeoutMs > 0) this.#timeout.refresh();
  }
}

function rawHeaderPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index]!, raw[index + 1]!]);
  return pairs;
}

function rewriteLocation(value: string, id: string): string {
  if (value.startsWith("/")) return `/share/${id}${value}`;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      return `/share/${id}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {}
  return value;
}

function rewriteCookiePath(value: string, id: string): string {
  return /(?:^|;)\s*Path=/i.test(value)
    ? value.replace(/(^|;)\s*Path=[^;]*/i, `$1 Path=/share/${id}/`)
    : `${value}; Path=/share/${id}/`;
}

function normalizeSuffix(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}
