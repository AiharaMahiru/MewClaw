import type { AuthContext, CredentialStore, Model } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import { LlmAdapter, LlmError, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter, type ResolvedPiAiProviderProfile } from "@deepseek-ai/dsh-llm-pi-ai";
import z from "@deepseek-ai/schemastery";
import type { WebModelRouteRef } from "dsh-lark-contracts";
import { UrlPolicy } from "dsh-lark-url-policy";

const PROVIDER = "web-private";
const DEFAULT_CONTEXT_WINDOW = 262_144;

export interface Config {
  authBaseUrl: string;
  tokenEnv: string;
}

export const Config: z<Config> = z.object({
  authBaseUrl: z.string().required(),
  tokenEnv: z.string().required(),
});

export const name = "web-private-model";
export const inject = ["llm", "credentials", "larkScopeIndex"];

interface CurrentModelRoute extends WebModelRouteRef {
  rpcId: string;
}

interface ScopeIndex {
  webModelRouteForCurrentSelection(sessionId: string): CurrentModelRoute | undefined;
}

interface RuntimeRoute {
  profileId: string;
  revision: number;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export interface WebPrivateModelAdapterOptions {
  authBaseUrl: string;
  workerToken: string;
  routes: ScopeIndex;
  fetch?: typeof fetch;
  urlPolicy?: UrlPolicy;
}

/**
 * 固定 provider `web-private` 的适配器。它不将 URL 或密钥注册到 Worker
 * 全局设置，而在每个流开始时以 Auth Edge capability 临时换取一条路由。
 */
export class WebPrivateModelAdapter extends LlmAdapter {
  readonly #authBaseUrl: string;
  readonly #workerToken: string;
  readonly #routes: ScopeIndex;
  readonly #fetch: typeof fetch;
  readonly #urlPolicy: UrlPolicy;

  constructor(options: WebPrivateModelAdapterOptions) {
    super();
    this.#authBaseUrl = normalizeAuthBaseUrl(options.authBaseUrl);
    this.#workerToken = options.workerToken;
    this.#routes = options.routes;
    this.#fetch = options.fetch ?? fetch;
    this.#urlPolicy = options.urlPolicy ?? new UrlPolicy();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider);
    return { id: PROVIDER, name: "我的模型" };
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    this.assertProvider(provider);
    return undefined;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider);
    // 目录只存在于账户中心，不能从 Worker 进程枚举任何用户的私有模型。
    return [];
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider);
    return modelInfo(model);
  }

  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    this.assertProvider(provider);
    const resolved = modelInfo(model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertProvider(options.provider);
    const sessionId = options.sessionId ? String(options.sessionId) : "";
    const reference = sessionId ? this.#routes.webModelRouteForCurrentSelection(sessionId) : undefined;
    if (!sessionId || !reference || reference.model !== options.model) {
      throw new LlmError("当前会话没有可用的私有模型路由", "PRIVATE_MODEL_ROUTE_UNAVAILABLE");
    }

    let route: RuntimeRoute | undefined;
    let apiKey: string | undefined;
    try {
      route = await this.resolveRoute(sessionId, reference);
      apiKey = route.apiKey;
      // Worker 侧再次 DNS 解析。Auth Edge 的保存/解析检查与这里均为必经点，
      // 配置保存后发生 DNS rebinding 也会在请求前被拒绝。
      const verifiedUrl = await this.#urlPolicy.assertAllowed(route.baseUrl, true);
      if (verifiedUrl.protocol !== "https:") throw new Error("HTTPS_REQUIRED");

      const profile = privateProfile(verifiedUrl.toString().replace(/\/$/u, ""), route.model);
      const temporary = new PiAiAdapter({
        profiles: () => new Map([[PROVIDER, profile]]),
        resolveApiKey: async () => {
          if (!apiKey) throw new LlmError("私有模型凭据已释放", "PRIVATE_MODEL_ROUTE_UNAVAILABLE");
          return apiKey;
        },
        auth: EMPTY_PI_AUTH,
      });
      for await (const chunk of temporary.stream({ ...options, provider: PROVIDER, model: route.model })) {
        yield sanitizeChunk(chunk);
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError("私有模型请求已取消", "ABORTED");
      if (error instanceof LlmError && (error.code === "PRIVATE_MODEL_ROUTE_UNAVAILABLE" || error.code === "ABORTED")) throw error;
      // 上游错误可能携带 URL、请求头或网关诊断；只向日志/客户端公开稳定错误码。
      throw new LlmError("私有模型请求失败", "PRIVATE_MODEL_REQUEST_FAILED");
    } finally {
      // 明文密钥只在当前 async generator 栈帧内存活，不进入 Scope 索引或日志。
      apiKey = undefined;
      route = undefined;
    }
  }

  private async resolveRoute(sessionId: string, reference: CurrentModelRoute): Promise<RuntimeRoute> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#authBaseUrl}/internal/models/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#workerToken}`,
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          sessionId,
          rpcId: reference.rpcId,
          capability: reference.capability,
          profileId: reference.profileId,
          revision: reference.revision,
          model: reference.model,
        }),
        signal: AbortSignal.any([AbortSignal.timeout(10_000)]),
      });
    } catch {
      throw new LlmError("私有模型路由暂不可用", "PRIVATE_MODEL_ROUTE_UNAVAILABLE");
    }
    if (!response.ok) throw new LlmError("私有模型路由不可用", "PRIVATE_MODEL_ROUTE_UNAVAILABLE");
    let body: unknown;
    try { body = await response.json(); } catch { throw new LlmError("私有模型路由不可用", "PRIVATE_MODEL_ROUTE_UNAVAILABLE"); }
    const route = parseRuntimeRoute(body);
    if (!route || route.profileId !== reference.profileId || route.revision !== reference.revision || route.model !== reference.model) {
      throw new LlmError("私有模型路由不可用", "PRIVATE_MODEL_ROUTE_UNAVAILABLE");
    }
    return route;
  }

  private assertProvider(provider: string): void {
    if (provider !== PROVIDER) throw new LlmError("私有模型路由无效", "NO_ADAPTER");
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const token = (await ctx.credentials!.resolve(config.tokenEnv as CredentialRef))?.value;
  if (!token) throw new Error("web-private-model: Worker 内部凭证未配置");
  const scopeIndex = (ctx as Context & { larkScopeIndex?: ScopeIndex }).larkScopeIndex;
  if (!scopeIndex) throw new Error("web-private-model: larkScopeIndex 未挂载");
  const adapter = new WebPrivateModelAdapter({ authBaseUrl: config.authBaseUrl, workerToken: token, routes: scopeIndex });
  ctx.llm.registerAdapter([PROVIDER], adapter);
}

function modelInfo(model: string): LlmResolvedModelInfo {
  if (!model || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) throw new LlmError("私有模型名称无效", "UNKNOWN_MODEL");
  return {
    provider: PROVIDER,
    id: model,
    name: model,
    inputModalities: ["text"],
    context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
  };
}

function privateProfile(baseURL: string, modelId: string): ResolvedPiAiProviderProfile {
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: baseURL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: 32_768,
  };
  return {
    provider: PROVIDER,
    displayName: "我的模型",
    api: "openai-completions",
    baseURL,
    models: undefined,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: DEFAULT_RETRY_POLICY,
    configuredMaxTokens: new Map(),
    piProvider: createProvider({
      id: PROVIDER,
      name: "我的模型",
      baseUrl: baseURL,
      auth: {
        apiKey: {
          name: "我的模型",
          resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: "私有模型" } : undefined,
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  } as ResolvedPiAiProviderProfile;
}

const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  mode: "normal",
  maxRetries: 0,
  retryableCodes: [],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
};

function normalizeAuthBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("web-private-model: Auth 内部地址无效"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !isLoopbackHost(url.hostname)) {
    throw new Error("web-private-model: Auth 内部地址必须是无凭据 loopback HTTP(S)");
  }
  return url.toString().replace(/\/$/u, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function parseRuntimeRoute(body: unknown): RuntimeRoute | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const route = (body as { route?: unknown }).route;
  if (!route || typeof route !== "object" || Array.isArray(route)) return undefined;
  const value = route as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "profileId" && key !== "revision" && key !== "model" && key !== "baseUrl" && key !== "apiKey")
    || typeof value.profileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.profileId)
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.model !== "string" || !value.model || value.model.length > 256
    || typeof value.baseUrl !== "string" || !value.baseUrl || value.baseUrl.length > 2048
    || typeof value.apiKey !== "string" || !value.apiKey || value.apiKey.length > 16_384) return undefined;
  return {
    profileId: value.profileId.toLowerCase(),
    revision: value.revision,
    model: value.model,
    baseUrl: value.baseUrl,
    apiKey: value.apiKey,
  };
}

function sanitizeChunk(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== "finish" || chunk.reason.kind === "stop" || chunk.reason.kind === "tool-calls") return chunk;
  if (chunk.reason.kind === "aborted") return { ...chunk, reason: { kind: "aborted", failure: { code: "ABORTED", message: "私有模型请求已取消" } } };
  return { ...chunk, reason: { kind: "error", failure: { code: "PRIVATE_MODEL_REQUEST_FAILED", message: "私有模型请求失败" } } };
}

const EMPTY_PI_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined; },
    async list() { return []; },
    async modify(_providerId, fn) { return fn(undefined); },
    async delete() { /* 私有 API Key 永不通过 pi-ai 凭据存储持久化。 */ },
  },
  authContext: {
    async env() { return undefined; },
    async fileExists() { return false; },
  },
};
