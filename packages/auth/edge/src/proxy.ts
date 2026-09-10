import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Transform, type TransformCallback } from "node:stream";

const MAX_PROXY_RESPONSE = 32 * 1024 * 1024;
const MAX_WEBSOCKET_MESSAGE = 16 * 1024 * 1024;
const UPGRADE_CLOSE_GRACE_MS = 250;

export interface ProxyResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface StreamingProxyOptions {
  stripResponseHeaders?: readonly string[];
}

export type WebSocketServerFrameFilter = (text: string) => string | null | Promise<string | null>;

/** 观察下游客户端发往上游的完整文本消息，不改变其原始 WebSocket 帧。 */
export type WebSocketClientFrameObserver = (text: string) => void;

export interface ProxyUpgradeOptions {
  filterServerFrames?: WebSocketServerFrameFilter;
  observeClientFrames?: WebSocketClientFrameObserver;
  stripResponseHeaders?: readonly string[];
}

interface UpgradeLifecycle {
  bind(socket: Socket): boolean;
  closed: Promise<void>;
  setFrameFilter(filter: Transform | undefined): void;
  setClientFrameObserver(observer: Transform | undefined): void;
  terminate(): void;
}

interface CloseEmitter {
  readonly closed?: boolean;
  once(event: "close", listener: () => void): unknown;
}

export function createWebSocketServerFrameFilter(filter: WebSocketServerFrameFilter): Transform {
  return new WebSocketServerFrameFilterTransform(filter);
}

export function createWebSocketClientFrameObserver(observer: WebSocketClientFrameObserver): Transform {
  return new WebSocketClientFrameObserverTransform(observer);
}

export async function requestUpstream(baseUrl: string, req: IncomingMessage, body?: Buffer, extraHeaders: IncomingHttpHeaders = {}, pathOverride?: string): Promise<ProxyResponse> {
  const target = new URL(pathOverride ?? req.url ?? "/", baseUrl);
  const headers = { ...forwardHeaders(req.headers, target), ...extraHeaders };
  return new Promise((resolve, reject) => {
    let settled = false;
    let upstreamSocket: Socket | undefined;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      req.off("error", onRequestError);
      req.off("aborted", onRequestAborted);
      req.off("close", onRequestClose);
      req.socket?.off("error", onRequestError);
      upstreamSocket?.off("error", onUpstreamSocketError);
      callback();
    };
    const upstream = httpRequest(target, { method: req.method, headers, agent: false }, (response) => {
      collectResponse(response).then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
    });
    const onRequestError = (error: Error): void => {
      upstream.destroy();
      settle(() => reject(error));
    };
    const onRequestAborted = (): void => onRequestError(new Error("client request aborted"));
    const onRequestClose = (): void => { if (!req.complete) onRequestAborted(); };
    const onUpstreamSocketError = (error: Error): void => settle(() => reject(error));
    upstream.once("error", onRequestError);
    upstream.once("socket", (socket) => { upstreamSocket = socket; socket.on("error", onUpstreamSocketError); });
    req.once("error", onRequestError);
    req.once("aborted", onRequestAborted);
    req.once("close", onRequestClose);
    req.socket?.once("error", onRequestError);
    if (body) upstream.end(body);
    else if (hasIncomingBody(req)) req.pipe(upstream);
    else upstream.end();
  });
}

export function streamUpstream(baseUrl: string, req: IncomingMessage, res: ServerResponse, extraHeaders: IncomingHttpHeaders = {}, options: StreamingProxyOptions = {}): Promise<void> {
  const target = new URL(req.url ?? "/", baseUrl);
  const headers = { ...forwardHeaders(req.headers, target), ...extraHeaders };
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      req.off("aborted", onAborted);
      req.off("error", onError);
      res.off("close", onResponseClose);
      if (error === undefined) resolve();
      else reject(error);
    };
    const upstream = httpRequest(target, { method: req.method, headers, agent: false }, (response) => {
      responseStarted = true;
      response.on("error", onError);
      response.once("end", () => settle());
      const responseHeaders = stripHopByHop(response.headers);
      for (const name of options.stripResponseHeaders ?? []) delete responseHeaders[name.toLowerCase()];
      try {
        res.writeHead(response.statusCode ?? 502, responseHeaders);
        response.pipe(res);
      } catch (error) {
        response.destroy();
        onError(error);
      }
    });
    const onError = (error: unknown): void => {
      upstream.destroy();
      if (responseStarted && !res.destroyed) res.destroy();
      settle(error);
    };
    const onAborted = (): void => onError(new Error("client request aborted"));
    const onResponseClose = (): void => {
      if (!res.writableEnded) upstream.destroy();
      settle();
    };
    upstream.once("error", onError);
    req.once("error", onError);
    req.once("aborted", onAborted);
    res.once("close", onResponseClose);
    if (hasIncomingBody(req)) req.pipe(upstream);
    else upstream.end();
  });
}

export function writeProxyResponse(res: ServerResponse, response: ProxyResponse): void {
  res.on("error", ignoreStreamError);
  if (res.destroyed || res.writableEnded) return;
  const headers = stripHopByHop(response.headers);
  delete headers["content-length"];
  headers["content-length"] = String(response.body.byteLength);
  try {
    res.writeHead(response.status, headers);
    res.end(response.body);
  } catch {
    res.destroy();
  }
}

export function proxyUpgrade(baseUrl: string, req: IncomingMessage, client: Duplex, head: Buffer, extraHeaders: IncomingHttpHeaders = {}, options: ProxyUpgradeOptions = {}): Promise<void> {
  if (client.destroyed) return Promise.resolve();
  const target = new URL(req.url ?? "/", baseUrl);
  const headers = { ...forwardHeaders(req.headers, target), ...extraHeaders };
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  client.on("error", ignoreStreamError);
  const upstream = httpRequest(target, { method: "GET", headers, agent: false });
  const lifecycle = createUpgradeLifecycle(client, upstream);
  client.once("close", lifecycle.terminate);
  upstream.once("error", lifecycle.terminate);
  upstream.once("socket", (socket) => { lifecycle.bind(socket); });
  upstream.once("upgrade", (response, socket, upstreamHead) => {
    if (!lifecycle.bind(socket)) return;
    const frameFilter = options.filterServerFrames ? createWebSocketServerFrameFilter(options.filterServerFrames) : undefined;
    const clientFrameObserver = options.observeClientFrames ? createWebSocketClientFrameObserver(options.observeClientFrames) : undefined;
    lifecycle.setFrameFilter(frameFilter);
    lifecycle.setClientFrameObserver(clientFrameObserver);
    const responseHeaders = stripSelectedHeaders(stripWebSocketExtensions(response.headers), options.stripResponseHeaders);
    if (!client.destroyed) client.write(formatHandshake(response.statusCode ?? 101, response.statusMessage ?? "Switching Protocols", responseHeaders));
    if (head.length && !socket.destroyed) {
      if (clientFrameObserver) clientFrameObserver.write(head);
      else socket.write(head);
    }
    frameFilter?.once("error", lifecycle.terminate);
    clientFrameObserver?.once("error", lifecycle.terminate);
    if (frameFilter) {
      if (upstreamHead.length) frameFilter.write(upstreamHead);
      socket.pipe(frameFilter).pipe(client);
    } else {
      if (upstreamHead.length && !client.destroyed) client.write(upstreamHead);
      socket.pipe(client);
    }
    if (clientFrameObserver) client.pipe(clientFrameObserver).pipe(socket);
    else client.pipe(socket);
    socket.once("end", () => client.end());
    socket.once("close", lifecycle.terminate);
  });
  upstream.once("response", (response) => {
    response.on("error", lifecycle.terminate);
    if (client.destroyed) { response.destroy(); return; }
    if (!client.destroyed) client.write(formatHandshake(response.statusCode ?? 502, response.statusMessage ?? "Bad Gateway", stripSelectedHeaders(response.headers, options.stripResponseHeaders)));
    response.pipe(client);
  });
  if (client.destroyed) { lifecycle.terminate(); return lifecycle.closed; }
  upstream.end();
  return lifecycle.closed;
}

function createUpgradeLifecycle(client: Duplex, upstream: ReturnType<typeof httpRequest>): UpgradeLifecycle {
  let upstreamSocket: Socket | undefined;
  let frameFilter: Transform | undefined;
  let clientFrameObserver: Transform | undefined;
  let terminated = false;
  let complete!: () => void;
  const resources = new Set<CloseEmitter>();
  const closed = new Promise<void>((resolve) => { complete = resolve; });
  const finish = (): void => { if (terminated && resources.size === 0) complete(); };
  const track = (resource: CloseEmitter): void => {
    if (resource.closed) return;
    resources.add(resource);
    resource.once("close", () => { resources.delete(resource); finish(); });
  };
  track(client);
  track(upstream);
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    frameFilter?.destroy();
    clientFrameObserver?.destroy();
    if (upstreamSocket) closeUpgradeSocket(upstreamSocket, upstream);
    else upstream.destroy();
    if (!client.destroyed) client.destroy();
    finish();
  };
  return {
    bind(socket) {
      if (upstreamSocket !== socket) { upstreamSocket = socket; track(socket); socket.once("error", terminate); }
      if (!terminated && !client.destroyed) return true;
      socket.destroy();
      return false;
    },
    closed,
    setFrameFilter(filter) { frameFilter = filter; },
    setClientFrameObserver(observer) { clientFrameObserver = observer; },
    terminate,
  };
}

function closeUpgradeSocket(socket: Socket, upstream: ReturnType<typeof httpRequest>): void {
  if (socket.destroyed) { upstream.destroy(); return; }
  const timer = setTimeout(() => socket.destroy(), UPGRADE_CLOSE_GRACE_MS);
  timer.unref();
  socket.once("close", () => { clearTimeout(timer); upstream.destroy(); });
  socket.end();
}

function ignoreStreamError(): void {}

function hasIncomingBody(req: IncomingMessage): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) return false;
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string") return Number.parseInt(contentLength, 10) > 0;
  return req.headers["transfer-encoding"] !== undefined;
}

async function collectResponse(response: IncomingMessage): Promise<ProxyResponse> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
    size += buffer.length;
    if (size > MAX_PROXY_RESPONSE) { response.destroy(); throw new Error("upstream response too large"); }
    chunks.push(buffer);
  }
  return { status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) };
}

function forwardHeaders(source: IncomingHttpHeaders, target: URL): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...source, host: target.host, origin: target.origin };
  for (const name of Object.keys(headers)) {
    if (isSensitiveRequestHeader(name)) delete headers[name];
  }
  delete headers["content-length"];
  delete headers["connection"];
  // 上游响应会被 Auth Edge 缓冲并可能改写 HTML；不接收压缩体，避免
  // 改写后仍携带原始 Content-Encoding 导致浏览器解码失败。
  delete headers["accept-encoding"];
  delete headers["sec-websocket-extensions"];
  headers.connection = "keep-alive";
  return headers;
}

function isSensitiveRequestHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "cookie"
    || normalized === "authorization"
    || normalized === "proxy-authorization"
    || normalized === "x-csrf-token"
    || normalized.startsWith("x-dsh-")
    || normalized === "x-auth-user"
    || normalized === "x-authenticated-user"
    || normalized === "x-user-id"
    || normalized === "x-forwarded-user"
    || normalized === "x-forwarded-client-cert"
    || /(?:^|-)identity(?:-|$)/u.test(normalized)
    || /(?:^|-)scope(?:-|$)/u.test(normalized);
}

function stripWebSocketExtensions(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const output = { ...headers };
  delete output["sec-websocket-extensions"];
  return output;
}

function stripSelectedHeaders(headers: IncomingHttpHeaders, names: readonly string[] | undefined): IncomingHttpHeaders {
  if (!names?.length) return headers;
  const output = { ...headers };
  for (const name of names) delete output[name.toLowerCase()];
  return output;
}

function stripHopByHop(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || ["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(key.toLowerCase())) continue;
    output[key] = value;
  }
  return output;
}

function formatHandshake(status: number, message: string, headers: IncomingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) lines.push(`${key}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

interface ParsedFrame {
  bytes: number;
  fin: boolean;
  opcode: number;
  payload: Buffer;
  raw: Buffer;
}

class WebSocketServerFrameFilterTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode: number | undefined;
  readonly #filter: WebSocketServerFrameFilter;

  constructor(filter: WebSocketServerFrameFilter) {
    super();
    this.#filter = filter;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.drain().then(() => callback(), (error: unknown) => callback(error as Error));
  }

  private async drain(): Promise<void> {
    while (true) {
      const frame = parseFrame(this.#buffer);
      if (!frame) return;
      this.#buffer = this.#buffer.subarray(frame.bytes);
      if (frame.opcode >= 0x8) {
        if (![0x8, 0x9, 0xa].includes(frame.opcode)) throw new Error(`unsupported WebSocket control opcode: ${frame.opcode}`);
        validateControlFrame(frame);
        this.push(frame.raw);
        continue;
      }
      if (frame.opcode === 0x0) {
        if (this.#fragmentOpcode === undefined) throw new Error("WebSocket continuation without an initial frame");
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (this.#fragmentOpcode !== undefined) throw new Error("WebSocket data frame interrupted by another data frame");
        this.#fragmentOpcode = frame.opcode;
      } else {
        throw new Error(`unsupported WebSocket opcode: ${frame.opcode}`);
      }
      this.#fragments.push(frame.raw);
      this.#fragmentBytes += frame.payload.length;
      if (this.#fragmentBytes > MAX_WEBSOCKET_MESSAGE) throw new Error("WebSocket message too large");
      if (!frame.fin) continue;
      const opcode = this.#fragmentOpcode;
      const payload = Buffer.concat(this.#fragments.map((raw) => framePayload(raw)), this.#fragmentBytes);
      const original = Buffer.concat(this.#fragments);
      this.#fragments = [];
      this.#fragmentBytes = 0;
      this.#fragmentOpcode = undefined;
      if (opcode !== 0x1) throw new Error("binary WebSocket server frame");
      const replacement = await this.#filter(payload.toString("utf8"));
      if (replacement === null) continue;
      if (replacement === payload.toString("utf8")) this.push(original);
      else this.push(encodeTextFrame(Buffer.from(replacement, "utf8")));
    }
  }
}

/**
 * 在客户端方向只观察完整文本消息，所有原始帧（包括掩码、分片和控制帧）
 * 均原样转发。观察器只用于记录 Remote mux 的 open/cancel，不承担协议校验。
 */
class WebSocketClientFrameObserverTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode: number | undefined;
  readonly #observer: WebSocketClientFrameObserver;

  constructor(observer: WebSocketClientFrameObserver) {
    super();
    this.#observer = observer;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.drain().then(() => callback(), (error: unknown) => callback(error as Error));
  }

  private async drain(): Promise<void> {
    while (true) {
      // 浏览器发出的 WebSocket 数据帧按 RFC 6455 必须带掩码；观察器要
      // 解码其完整消息供策略记录，但仍把原始帧无损写回上游。
      const frame = parseFrame(this.#buffer, true);
      if (!frame) return;
      this.#buffer = this.#buffer.subarray(frame.bytes);
      if (frame.opcode >= 0x8) {
        if (![0x8, 0x9, 0xa].includes(frame.opcode)) throw new Error(`unsupported WebSocket control opcode: ${frame.opcode}`);
        validateControlFrame(frame);
        this.push(frame.raw);
        continue;
      }
      if (frame.opcode === 0x0) {
        if (this.#fragmentOpcode === undefined) throw new Error("WebSocket continuation without an initial frame");
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (this.#fragmentOpcode !== undefined) throw new Error("WebSocket data frame interrupted by another data frame");
        this.#fragmentOpcode = frame.opcode;
      } else {
        throw new Error(`unsupported WebSocket opcode: ${frame.opcode}`);
      }
      this.#fragments.push(frame.raw);
      this.#fragmentBytes += frame.payload.length;
      if (this.#fragmentBytes > MAX_WEBSOCKET_MESSAGE) throw new Error("WebSocket message too large");
      if (!frame.fin) continue;
      const opcode = this.#fragmentOpcode;
      const payload = Buffer.concat(this.#fragments.map((raw) => framePayload(raw)), this.#fragmentBytes);
      const original = Buffer.concat(this.#fragments);
      this.#fragments = [];
      this.#fragmentBytes = 0;
      this.#fragmentOpcode = undefined;
      if (opcode === 0x1) this.#observer(payload.toString("utf8"));
      this.push(original);
    }
  }
}

function parseFrame(buffer: Buffer, allowMasked = false): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0]!;
  if ((first & 0x70) !== 0) throw new Error("unsupported WebSocket extensions");
  const second = buffer[1]!;
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  if (masked && !allowMasked) throw new Error("masked WebSocket server frame");
  const marker = second & 0x7f;
  let length = marker;
  let offset = 2;
  if (marker === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (marker === 127) {
    if (buffer.length < 10) return undefined;
    const high = buffer.readUInt32BE(2);
    if (high > 0x001fffff) throw new Error("WebSocket frame length exceeds safe limit");
    length = high * 2 ** 32 + buffer.readUInt32BE(6);
    offset = 10;
  }
  if (length > MAX_WEBSOCKET_MESSAGE) throw new Error("WebSocket frame too large");
  const maskOffset = masked ? 4 : 0;
  const total = offset + maskOffset + length;
  if (buffer.length < total) return undefined;
  const raw = Buffer.from(buffer.subarray(0, total));
  const payload = Buffer.from(buffer.subarray(offset + maskOffset, total));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let index = 0; index < payload.length; index++) {
      const maskByte = mask[index % 4];
      if (maskByte === undefined) throw new Error("invalid WebSocket mask");
      payload[index] = payload[index]! ^ maskByte;
    }
  }
  return { bytes: total, fin, opcode, payload, raw };
}

function framePayload(frame: Buffer): Buffer {
  const marker = frame[1]! & 0x7f;
  const offset = marker < 126 ? 2 : marker === 126 ? 4 : 10;
  const masked = (frame[1]! & 0x80) !== 0;
  const maskOffset = masked ? 4 : 0;
  const payload = Buffer.from(frame.subarray(offset + maskOffset));
  if (masked) {
    const mask = frame.subarray(offset, offset + 4);
    for (let index = 0; index < payload.length; index++) {
      const maskByte = mask[index % 4];
      if (maskByte === undefined) throw new Error("invalid WebSocket mask");
      payload[index] = payload[index]! ^ maskByte;
    }
  }
  return payload;
}

function validateControlFrame(frame: ParsedFrame): void {
  if (!frame.fin || frame.payload.length > 125) throw new Error("invalid WebSocket control frame");
}

function encodeTextFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_WEBSOCKET_MESSAGE) throw new Error("WebSocket replacement too large");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(payload.length, 6);
  return Buffer.concat([header, payload]);
}
