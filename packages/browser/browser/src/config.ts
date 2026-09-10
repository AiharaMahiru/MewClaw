import z from "@deepseek-ai/schemastery";

export interface Config {
  browserBaseUrl?: string;
  tokenEnv?: string;
  requestTimeoutMs?: number;
}

export interface ResolvedClientConfig {
  browserBaseUrl: string;
  tokenEnv: string;
  requestTimeoutMs: number;
}

export const Config: z<Config> = z.object({
  browserBaseUrl: z.string(),
  tokenEnv: z.string(),
  requestTimeoutMs: z.number(),
});

export function resolveClientConfig(config: Config): ResolvedClientConfig {
  const browserBaseUrl = config.browserBaseUrl === undefined
    ? "http://127.0.0.1:13083"
    : validateLoopbackUrl(config.browserBaseUrl);
  const tokenEnv = config.tokenEnv === undefined ? "WORKER_TOKEN" : config.tokenEnv.trim();
  if (!tokenEnv) throw new Error("dsh-browser: tokenEnv 不能为空");
  const requestTimeoutMs = boundedInteger(config.requestTimeoutMs, 30_000, 1_000, 120_000);
  return { browserBaseUrl, tokenEnv, requestTimeoutMs };
}

function validateLoopbackUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("dsh-browser: browserBaseUrl 非法");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("dsh-browser: browserBaseUrl 必须是无凭证、无路径的 loopback HTTP URL");
  }
  return url.href.replace(/\/$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-browser: requestTimeoutMs 必须为 ${minimum}..${maximum} 的安全整数`);
  }
  return value;
}
