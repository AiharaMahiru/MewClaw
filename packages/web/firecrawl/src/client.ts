/** Firecrawl REST 传输层：轮换凭证、超时、取消与脱敏均集中在此处。 */
export interface FirecrawlClient {
  post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  postWithKey(path: string, body: unknown, signal?: AbortSignal): Promise<FirecrawlRequestResult>;
  get(path: string, apiKey: string, signal?: AbortSignal): Promise<unknown>;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export interface FirecrawlRequestResult {
  payload: unknown;
  /** 仅供同包的异步任务轮询复用，绝不返回模型或日志。 */
  apiKey: string;
}

export interface FirecrawlClientOptions {
  apiUrl: string;
  apiKeys: readonly string[];
  timeoutMs: number;
}

const RETRY_COUNT = 2;
const RETRY_BASE_DELAY_MS = 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_SWITCH_STATUS = new Set([401, 402, 429]);

class FirecrawlKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirecrawlKeyError";
  }
}

function invalidJsonResponse(): Error {
  return new Error("Firecrawl returned invalid JSON");
}

function declaredBodySize(response: Response): number {
  const header = response.headers.get("content-length");
  if (header === null) return 0;
  if (!/^\d+$/.test(header)) throw invalidJsonResponse();
  const size = Number(header);
  if (!Number.isSafeInteger(size)) throw invalidJsonResponse();
  return size;
}

async function readResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidJsonResponse();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    if (declaredBodySize(response) > MAX_RESPONSE_BYTES) throw invalidJsonResponse();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalidJsonResponse();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    throw invalidJsonResponse();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await readResponseText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw invalidJsonResponse();
  }
}

/** 构建一个脱敏、取消感知的 Firecrawl REST 客户端。 */
export function createFirecrawlClient(options: FirecrawlClientOptions): FirecrawlClient {
  let cursor = 0;
  const redact = (text: string): string => options.apiKeys.reduce(
    (value, key) => value.replaceAll(key, "[REDACTED]"),
    text.replaceAll(options.apiUrl, "[REDACTED]"),
  );

  const wait = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Firecrawl request cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Firecrawl request cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const requestOnce = async (
    apiKey: string,
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (signal?.aborted) throw new Error("Firecrawl request cancelled");
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${options.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error) {
      throw new Error(redact(`Firecrawl request failed: ${error instanceof Error ? error.message : "network error"}`));
    }
    if (KEY_SWITCH_STATUS.has(response.status)) {
      throw new FirecrawlKeyError(redact(`Firecrawl key rejected (${response.status})`));
    }
    if (!response.ok) throw new Error(redact(`Firecrawl request failed (${response.status})`));
    return readJsonResponse(response);
  };

  const postWithKey = async (path: string, body: unknown, signal?: AbortSignal): Promise<FirecrawlRequestResult> => {
    let lastKeyError: FirecrawlKeyError | undefined;
    for (let round = 0; round <= RETRY_COUNT; round += 1) {
      if (round > 0) await wait(RETRY_BASE_DELAY_MS * 2 ** (round - 1), signal);
      for (let index = 0; index < options.apiKeys.length; index += 1) {
        const apiKey = options.apiKeys[(cursor + index) % options.apiKeys.length]!;
        try {
          const payload = await requestOnce(apiKey, "POST", path, body, signal);
          cursor = (cursor + index + 1) % options.apiKeys.length;
          return { payload, apiKey };
        } catch (error) {
          if (error instanceof FirecrawlKeyError) {
            lastKeyError = error;
            continue;
          }
          throw error;
        }
      }
    }
    throw lastKeyError ?? new Error("Firecrawl request failed");
  };

  return {
    post: async (path, body, signal) => (await postWithKey(path, body, signal)).payload,
    postWithKey,
    get: (path, apiKey, signal) => requestOnce(apiKey, "GET", path, undefined, signal),
    wait,
  };
}
