import type { CredentialRef } from "@deepseek-ai/dsh-credentials";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const PAIRING_PATH = "/internal/pairing/start";
const PAIRING_RESULT_PATH = "/auth/pair";
const DEFAULT_TOKEN_ENV = "AUTH_PAIRING_TOKEN";
const MAX_URL_LENGTH = 4096;

export interface PairingCredentialResolver {
  resolve(reference: CredentialRef): Promise<{ value: string } | undefined>;
}

export interface FeishuPairingClientOptions {
  endpoint?: string;
  tokenEnv?: string | undefined;
  credentials: PairingCredentialResolver;
  request?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export type PairingErrorCode = "PAIRING_NOT_CONFIGURED" | "PAIRING_UNAVAILABLE" | "PAIRING_INVALID_RESPONSE";

export class PairingClientError extends Error {
  constructor(readonly code: PairingErrorCode) {
    super(code);
    this.name = "PairingClientError";
  }
}

export type FeishuPairingBinding =
  | { status: "bound"; displayName: string; email: string }
  | { status: "unbound" };

export interface FeishuPairingIssue {
  url: string;
  binding: FeishuPairingBinding;
}

export interface FeishuPairingClient {
  issue(openId: string, sessionId: string): Promise<FeishuPairingIssue>;
}

export function createFeishuPairingClient(options: FeishuPairingClientOptions): FeishuPairingClient | undefined {
  const endpoint = normalizeEndpoint(options.endpoint);
  if (!endpoint) return undefined;
  return new DefaultFeishuPairingClient(endpoint, options.tokenEnv, options.credentials, options.request ?? globalThis.fetch.bind(globalThis));
}

class DefaultFeishuPairingClient implements FeishuPairingClient {
  constructor(
    private readonly endpoint: string,
    private readonly tokenEnv: string | undefined,
    private readonly credentials: PairingCredentialResolver,
    private readonly request: (input: string | URL, init?: RequestInit) => Promise<Response>,
  ) {}

  async issue(openId: string, sessionId: string): Promise<FeishuPairingIssue> {
    const token = await this.resolveToken();
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ openId, sessionId }),
      });
    } catch {
      throw new PairingClientError("PAIRING_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PairingClientError(response.status === 401 || response.status === 503 ? "PAIRING_NOT_CONFIGURED" : "PAIRING_UNAVAILABLE");
    }
    const body = await response.json().catch(() => undefined);
    if (!isRecord(body) || typeof body.url !== "string" || !isPairingBinding(body.binding)) {
      throw new PairingClientError("PAIRING_INVALID_RESPONSE");
    }
    return { url: normalizePairingUrl(body.url), binding: body.binding };
  }

  private async resolveToken(): Promise<string> {
    const reference = (this.tokenEnv?.trim() || DEFAULT_TOKEN_ENV) as CredentialRef;
    try {
      const resolved = await this.credentials.resolve(reference);
      if (resolved?.value) return resolved.value;
    } catch {
      // 凭证提供方故障不把内部错误暴露给飞书用户。
    }
    throw new PairingClientError("PAIRING_NOT_CONFIGURED");
  }
}

function normalizeEndpoint(input: string | undefined): string | undefined {
  if (!input?.trim()) return undefined;
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error("lark-commands: pairingEndpoint URL 无效"); }
  if (!["http:", "https:"].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.pathname !== PAIRING_PATH || parsed.search || parsed.hash) {
    throw new Error("lark-commands: pairingEndpoint 必须是 loopback auth-edge 配对端点");
  }
  return parsed.toString();
}

function normalizePairingUrl(input: string): string {
  if (input.length > MAX_URL_LENGTH) throw new PairingClientError("PAIRING_INVALID_RESPONSE");
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new PairingClientError("PAIRING_INVALID_RESPONSE"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== PAIRING_RESULT_PATH || parsed.hash) {
    throw new PairingClientError("PAIRING_INVALID_RESPONSE");
  }
  return parsed.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isPairingBinding(value: unknown): value is FeishuPairingBinding {
  if (!isRecord(value) || (value.status !== "bound" && value.status !== "unbound")) return false;
  if (value.status === "unbound") return true;
  return isBoundBindingText(value.displayName, 120) && isBoundBindingText(value.email, 320);
}

function isBoundBindingText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}
