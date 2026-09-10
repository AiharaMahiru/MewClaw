import type { Scope } from "dsh-lark-contracts";

import { PreviewError, parsePreviewId, type PreviewDescriptor, type PreviewErrorCode, type PreviewService } from "./types.js";

export interface PreviewClientOptions {
  baseUrl: string;
  token: string;
  requestTimeoutMs: number;
  fetch?: typeof fetch;
}

const ERROR_CODES = new Set<PreviewErrorCode>([
  "PREVIEW_INVALID_INPUT", "PREVIEW_FORBIDDEN", "PREVIEW_QUOTA",
  "PREVIEW_UNAVAILABLE", "PREVIEW_NOT_FOUND", "PREVIEW_UPSTREAM",
]);

export class PreviewHttpClient implements PreviewService {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: PreviewClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#timeout = options.requestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  async publish(input: Parameters<PreviewService["publish"]>[0]): Promise<PreviewDescriptor> {
    return parseDescriptor(await this.#request("/api/preview/create", input));
  }

  async list(scope: Scope): Promise<readonly PreviewDescriptor[]> {
    const result = await this.#request("/api/preview/list", { scope });
    if (!Array.isArray(result)) throw new PreviewError("PREVIEW_UNAVAILABLE", "preview daemon 返回了非法列表");
    return result.map(parseDescriptor);
  }

  async revoke(scope: Scope, id: string): Promise<void> {
    await this.#request("/api/preview/revoke", { scope, id });
  }

  async dispose(): Promise<void> {}

  async #request(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      throw new PreviewError("PREVIEW_UNAVAILABLE", "preview daemon 不可用");
    }
    const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    if (!response.ok) {
      const code = typeof payload?.error === "string" && ERROR_CODES.has(payload.error as PreviewErrorCode)
        ? payload.error as PreviewErrorCode
        : "PREVIEW_UNAVAILABLE";
      throw new PreviewError(code);
    }
    return payload;
  }
}

function parseDescriptor(value: unknown): PreviewDescriptor {
  if (!value || typeof value !== "object") invalidDescriptor();
  const item = value as Record<string, unknown>;
  const id = parsePreviewId(item.id);
  if (!id || typeof item.url !== "string" || typeof item.createdAt !== "string"
    || typeof item.expiresAt !== "string" || !Number.isSafeInteger(item.port)) invalidDescriptor();
  return {
    id,
    url: item.url,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    port: item.port as number,
  };
}

function invalidDescriptor(): never {
  throw new PreviewError("PREVIEW_UNAVAILABLE", "preview daemon 返回了非法描述符");
}
