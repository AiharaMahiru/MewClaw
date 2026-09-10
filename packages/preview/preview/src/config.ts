import z from "@deepseek-ai/schemastery";

export interface Config {
  previewBaseUrl?: string;
  tokenEnv: string;
  requestTimeoutMs?: number;
}

export interface ResolvedClientConfig {
  previewBaseUrl: string;
  tokenEnv: string;
  requestTimeoutMs: number;
}

export const Config: z<Config> = z.object({
  previewBaseUrl: z.string(),
  tokenEnv: z.string().required(),
  requestTimeoutMs: z.number(),
});

export function resolveClientConfig(config: Config): ResolvedClientConfig {
  const previewBaseUrl = config.previewBaseUrl === undefined
    ? "http://127.0.0.1:13082"
    : validateLoopbackUrl(config.previewBaseUrl);
  const requestTimeoutMs = boundedInteger(config.requestTimeoutMs, 30_000, 1_000, 120_000, "requestTimeoutMs");
  if (!config.tokenEnv.trim()) throw new Error("dsh-preview: tokenEnv 不能为空");
  return { previewBaseUrl, tokenEnv: config.tokenEnv, requestTimeoutMs };
}

function validateLoopbackUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("dsh-preview: previewBaseUrl 非法"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password
    || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("dsh-preview: previewBaseUrl 必须是无凭证、无路径的 loopback HTTP URL");
  }
  return url.href.replace(/\/$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`dsh-preview: ${field} 必须为 ${minimum}..${maximum} 的安全整数`);
  }
  return value;
}
