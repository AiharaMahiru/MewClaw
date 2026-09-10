export interface FirecrawlConfigInput {
  apiUrl?: string;
  timeoutMs?: number;
}

export interface ResolvedFirecrawlConfig {
  apiUrl: string;
  timeoutMs: number;
}

const DEFAULT_API_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

function resolveApiUrl(value: string | undefined): string {
  const apiUrl = (value === undefined ? DEFAULT_API_URL : value).trim().replace(/\/+$/, "");
  if (!apiUrl) throw new Error("web-firecrawl: apiUrl must be non-empty");
  try {
    const parsed = new URL(apiUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      throw new Error("web-firecrawl: apiUrl must be an HTTP(S) URL without embedded credentials");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("web-firecrawl:")) throw error;
    throw new Error("web-firecrawl: apiUrl must be an HTTP(S) URL");
  }
  return apiUrl;
}

/** 在凭证解析前固定外部 Provider 的可达地址和等待预算。 */
export function resolveFirecrawlConfig(input: FirecrawlConfigInput): ResolvedFirecrawlConfig {
  const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`web-firecrawl: timeoutMs must be an integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
  }
  return { apiUrl: resolveApiUrl(input.apiUrl), timeoutMs };
}
