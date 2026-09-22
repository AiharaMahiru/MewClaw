import { RemoteClientError, errorFromWire, normalizeErrorCode } from './errors.js';
import { CookieJar } from './cookie-jar.js';
import type { FetchLike, RemoteClientOptions } from './types.js';

export interface NormalizedEndpoint {
  readonly origin: string;
  readonly basePath: string;
  readonly http: URL;
  readonly websocket: URL;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** dsh Web 公共 HTTP 载体：负责 origin、Cookie、CSRF 和安全错误归一化。 */
export class RemoteHttpTransport {
  readonly endpoint: NormalizedEndpoint;
  readonly cookies: CookieJar;
  readonly websocketFactory: RemoteClientOptions['websocketFactory'];
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly logger: RemoteClientOptions['logger'];

  constructor(options: RemoteClientOptions, cookies = new CookieJar()) {
    this.endpoint = normalizeEndpoint(options.endpoint, options.allowInsecureHttp === true);
    this.cookies = cookies;
    this.websocketFactory = options.websocketFactory;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = positiveInteger(options.requestTimeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxResponseBytes = positiveInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.logger = options.logger;
  }

  url(pathname: string): URL {
    if (!pathname.startsWith('/') || pathname.split('/').some(part => part === '..')) throw new RemoteClientError('INVALID_ENDPOINT');
    return new URL(`${this.endpoint.basePath}${pathname}`, this.endpoint.origin);
  }

  async bootstrap(signal?: AbortSignal): Promise<void> {
    const response = await this.request('/', { method: 'GET' }, signal);
    if (response.status >= 400) throw errorFromWire(response.body, response.status);
  }

  async request(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<TransportResponse> {
    const url = this.url(pathname);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('origin', this.endpoint.origin);
    const cookie = this.cookies.header(url);
    if (cookie) headers.set('cookie', cookie);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrf = this.cookies.csrf();
      if (csrf) headers.set('x-csrf-token', csrf);
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, method, headers, redirect: 'error', signal: requestSignal });
    } catch (error) {
      if (requestSignal.aborted && !signal?.aborted) throw new RemoteClientError('REQUEST_TIMEOUT');
      if (error instanceof RemoteClientError) throw error;
      throw new RemoteClientError('NETWORK_UNAVAILABLE');
    }
    this.cookies.setFromHeaders(response.headers, url);
    const body = await readBody(response, this.maxResponseBytes);
    this.logger?.('http_response', { status: response.status, method });
    return { status: response.status, headers: response.headers, body };
  }

  async json(pathname: string, init: RequestInit = {}, signal?: AbortSignal, csrfRetry = true): Promise<unknown> {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !this.cookies.csrf()) await this.bootstrap(signal);
    let response = await this.request(pathname, init, signal);
    if (response.status === 403 && csrfRetry && isWireCode(response.body, 'CSRF_INVALID')) {
      // CSRF 失败发生在 Auth Edge 分发前；重新取得首页 Cookie 后只重试这一层。
      this.cookies.delete('dsh_csrf');
      await this.bootstrap(signal);
      response = await this.request(pathname, init, signal);
    }
    if (response.status < 200 || response.status >= 300) throw errorFromWire(response.body, response.status);
    return response.body;
  }
}

export function normalizeEndpoint(input: string, allowInsecureHttp: boolean): NormalizedEndpoint {
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new RemoteClientError('INVALID_ENDPOINT'); }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RemoteClientError('INVALID_ENDPOINT');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === '::1';
  if (parsed.protocol === 'http:' && !allowInsecureHttp && !loopback) throw new RemoteClientError('INVALID_ENDPOINT');
  const basePath = parsed.pathname.replace(/\/+$/u, '');
  const origin = parsed.origin;
  const http = new URL(`${basePath || ''}/`, origin);
  const websocket = new URL(`${basePath || ''}/api/remote.mux`, origin.replace(/^http/u, 'ws'));
  return { origin, basePath, http, websocket };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function readBody(response: Response, maxBytes: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number.isSafeInteger(Number(length)) && Number(length) > maxBytes) throw new RemoteClientError('REMOTE_UNAVAILABLE');
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new RemoteClientError('REMOTE_UNAVAILABLE');
  if (!text.trim()) return undefined;
  try { return JSON.parse(text) as unknown; }
  catch {
    // HTML 登录页或代理错误不应原样进入错误消息。
    return undefined;
  }
}

function isWireCode(value: unknown, expected: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const direct = typeof record.error === 'string' ? record.error : typeof record.code === 'string' ? record.code : undefined;
  if (direct && normalizeErrorCode(direct) === expected) return true;
  const result = record.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const error = (result as Record<string, unknown>).error;
  return !!error && typeof error === 'object' && !Array.isArray(error)
    && normalizeErrorCode((error as Record<string, unknown>).code) === expected;
}
