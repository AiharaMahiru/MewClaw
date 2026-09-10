import { BrowserError, type BrowserConsoleLevel, type BrowserConsoleResult, type BrowserErrorCode,
  type BrowserEvaluateResult, type BrowserNetworkResult, type BrowserPage, type BrowserScreenshotResult,
  type BrowserService, type BrowserSnapshot } from "./types.js";

export interface BrowserClientOptions {
  baseUrl: string;
  token: string;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const ERROR_MESSAGE_LIMIT = 500;
const ERROR_CODES = new Set<BrowserErrorCode>([
  "BROWSER_INVALID_INPUT", "BROWSER_FORBIDDEN", "BROWSER_NOT_OPEN", "BROWSER_NOT_FOUND",
  "BROWSER_TIMEOUT", "BROWSER_QUOTA", "BROWSER_CONFLICT", "BROWSER_UNAVAILABLE", "BROWSER_UPSTREAM", "BROWSER_SCRIPT_ERROR",
]);

export class BrowserHttpClient implements BrowserService {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: BrowserClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#timeout = options.requestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async open(input: Parameters<BrowserService["open"]>[0]): Promise<BrowserPage> {
    return parsePage(await this.#request("open", input));
  }

  async snapshot(input: Parameters<BrowserService["snapshot"]>[0]): Promise<BrowserSnapshot> {
    const value = record(await this.#request("snapshot", input));
    const truncated = value.truncated === true;
    const content = truncated
      ? string(value.preview, "preview", 120_000)
      : stringifyBounded({ text: value.text, elements: value.elements, nodes: value.nodes }, 120_000, "snapshot");
    const url = typeof value.url === "string" ? string(value.url, "url", 8_192) : "";
    const title = typeof value.title === "string" ? string(value.title, "title", 1_000) : "";
    return { url, title, content, truncated };
  }

  async click(input: Parameters<BrowserService["click"]>[0]): Promise<{ clicked: boolean }> {
    const { scope, selector } = input;
    const value = record(await this.#request("click", { scope, selector }));
    return { clicked: boolean(value.clicked, "clicked") };
  }

  async type(input: Parameters<BrowserService["type"]>[0]): Promise<{ typed: boolean }> {
    const { scope, selector, text } = input;
    const value = record(await this.#request("type", { scope, selector, text }));
    return { typed: boolean(value.typed, "typed") };
  }

  async wait(input: Parameters<BrowserService["wait"]>[0]): Promise<{ found?: boolean; waited?: number }> {
    const { scope, selector, milliseconds } = input;
    const value = record(await this.#request("wait", {
      scope,
      ...(selector === undefined ? {} : { selector }),
      ...(milliseconds === undefined ? {} : { milliseconds }),
    }));
    if (value.found === true) return { found: true };
    return { waited: integer(value.waited, "waited", 0, 120_000) };
  }

  async evaluate(input: Parameters<BrowserService["evaluate"]>[0]): Promise<BrowserEvaluateResult> {
    const value = await this.#request("evaluate", input);
    const truncated = isTruncated(value);
    return { result: truncated ? string(record(value).preview, "preview", 40_000) : stringifyBounded(value, 40_000, "result"), truncated };
  }

  async console(input: Parameters<BrowserService["console"]>[0]): Promise<BrowserConsoleResult> {
    const value = record(await this.#request("console", { scope: input.scope }));
    const source = array(value.entries, "entries", 2_000);
    const filtered = input.level === undefined ? source : source.filter((entry) => consoleMatches(entry, input.level!));
    const limit = input.limit ?? 100;
    return { entries: filtered.slice(-limit).map((entry) => stringifyBounded(entry, 4_000, "console entry")), truncated: filtered.length > limit };
  }

  async network(input: Parameters<BrowserService["network"]>[0]): Promise<BrowserNetworkResult> {
    const value = record(await this.#request("network", { scope: input.scope }));
    const source = array(value.entries, "entries", 2_000);
    const limit = input.limit ?? 100;
    return { entries: source.slice(-limit).map((entry) => stringifyBounded(entry, 4_000, "network entry")), truncated: source.length > limit };
  }

  async screenshot(input: Parameters<BrowserService["screenshot"]>[0]): Promise<BrowserScreenshotResult> {
    const value = record(await this.#request("screenshot", input));
    const path = string(value.path, "path", 1_024);
    if (!isRelativePath(path)) invalidResponse("path");
    return { path };
  }

  async close(input: Parameters<BrowserService["close"]>[0]): Promise<{ closed: boolean }> {
    const value = record(await this.#request("close", input));
    return { closed: boolean(value.closed, "closed") };
  }

  async dispose(): Promise<void> {}

  async #request(operation: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/browser/action`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...(body as Record<string, unknown>), operation }),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new BrowserError("BROWSER_TIMEOUT", "browser daemon 请求超时", 504, true);
      }
      throw new BrowserError("BROWSER_UNAVAILABLE", "browser daemon 不可用", undefined, true);
    }
    const payload = await readJsonBounded(response);
    if (!response.ok) throw parseError(payload, response.status);
    return payload;
  }
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new BrowserError("BROWSER_UNAVAILABLE", "browser daemon 响应过大");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof BrowserError) throw error;
    throw new BrowserError("BROWSER_UNAVAILABLE", "browser daemon 响应读取失败", undefined, true);
  }
  const text = new TextDecoder().decode(concat(chunks, length));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BrowserError("BROWSER_UNAVAILABLE", "browser daemon 返回了非法 JSON");
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parseError(payload: unknown, status: number): BrowserError {
  const outer = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const detail = outer?.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : outer;
  const rawCode = typeof detail?.code === "string" ? detail.code : typeof outer?.error === "string" ? outer.error : undefined;
  const code = rawCode && ERROR_CODES.has(rawCode as BrowserErrorCode)
    ? rawCode as BrowserErrorCode
    : status === 401 || status === 403 ? "BROWSER_FORBIDDEN" : "BROWSER_UPSTREAM";
  const rawMessage = typeof detail?.message === "string" ? detail.message : undefined;
  const message = rawMessage?.trim().slice(0, ERROR_MESSAGE_LIMIT) || code;
  return new BrowserError(code, message, status, detail?.retryable === true || status >= 500);
}

function parsePage(value: unknown): BrowserPage {
  const item = record(value);
  return { url: string(item.url, "url", 8_192), title: typeof item.title === "string" ? string(item.title, "title", 1_000) : "" };
}

function stringifyBounded(value: unknown, maximum: number, field: string): string {
  let result: string;
  try { result = typeof value === "string" ? value : JSON.stringify(value); } catch { invalidResponse(field); }
  if (result === undefined || result.length > maximum) invalidResponse(field);
  return result;
}

function isTruncated(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).truncated === true);
}

function consoleMatches(value: unknown, level: BrowserConsoleLevel): boolean {
  const type = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).type : undefined;
  const rank: Record<BrowserConsoleLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };
  const normalized = type === "warn" ? "warning" : type === "log" ? "info" : type;
  return typeof normalized === "string" && normalized in rank && rank[normalized as BrowserConsoleLevel] >= rank[level];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse("object");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) invalidResponse(field);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalidResponse(field);
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) invalidResponse(field);
  return Number(value);
}

function array(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalidResponse(field);
  return value;
}

function isRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.startsWith("\\")
    && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes("..");
}

function invalidResponse(field: string): never {
  throw new BrowserError("BROWSER_UNAVAILABLE", `browser daemon 返回了非法字段：${field}`);
}
