/** 本地会话的云端模型桥接；配置由云端账号决定，API Key 始终留在服务器。 */
import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { LlmAdapter, LlmError, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';

export const CLOUD_MODEL_PROVIDER = 'mewclaw-cloud';
const MODEL = 'cloud-default';
const CONTEXT_WINDOW = 262144;
const MAX_TOKENS = 32768;
const CATALOG_TTL_MS = 5000;
const NO_RETRY = { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
const EMPTY_AUTH: PiAiAdapterOptions['auth'] = {
  credentials: { async read() { return undefined; }, async list() { return []; }, async modify(_id, fn) { return fn(undefined); }, async delete() {} },
  authContext: { async env() { return undefined; }, async fileExists() { return false; } },
};

interface CloudModelProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  defaultModel: string;
  keyConfigured: boolean;
}

interface CloudSharedModel {
  provider: string;
  model: string;
  name: string;
}

interface CloudModelCatalog {
  profiles: CloudModelProfile[];
  sharedModels: CloudSharedModel[];
  defaultProfileId: string | null;
}

/** `model` 字段是服务端路由选择器：cloud-default / account/<pid>[/<model>] / shared/<provider>/<model>。 */
interface CatalogEntry {
  selector: string;
  name: string;
  description: string;
}

interface CachedCatalog {
  cookie: string;
  expiresAt: number;
  catalog: CloudModelCatalog;
}

export class CloudAccountModel extends LlmAdapter {
  private cached: CachedCatalog | undefined;
  private pending: Promise<CloudModelCatalog> | undefined;
  private pendingCookie: string | undefined;

  constructor(private readonly options: {
    origin: string;
    cookie(): string;
    enabled?: () => boolean;
    fetch?: typeof globalThis.fetch;
    catalogTtlMs?: number;
  }) { super(); }
  override providerInfo() { return { id: CLOUD_MODEL_PROVIDER, name: '云端账号模型桥接' }; }
  invalidateCatalog(): void { this.cached = undefined; }
  override async listModels() {
    if (!this.isEnabled()) return [];
    try { return catalogEntries(await this.catalog()).map(entry => this.info(entry)); } catch { return []; }
  }
  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!this.isEnabled()) throw new LlmError('当前模式未启用云端账号模型桥接。', 'MODEL_NOT_FOUND');
    return this.info(this.entry(await this.catalog(), model));
  }
  private info(entry: CatalogEntry): LlmResolvedModelInfo {
    return {
      provider: CLOUD_MODEL_PROVIDER,
      id: entry.selector,
      name: entry.name,
      description: entry.description,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_TOKENS,
    };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.isEnabled()) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CLOUD_MODEL_DISABLED', message: '当前模式未启用云端账号模型桥接。' } } };
      return;
    }
    const cookie = this.options.cookie();
    const csrf = /(?:^|;\s*)dsh_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!csrf || !/(?:^|;\s*)(?:__Host-dsh_session|dsh_session)=/.test(cookie)) {
      throw new LlmError('请先在云端登录账号后再使用本地会话模型。', 'CLOUD_LOGIN_REQUIRED');
    }
    const entry = this.entry(await this.catalog(), options.model);
    const profile = gatewayProfile(this.options.origin, { cookie, origin: this.options.origin, 'x-csrf-token': decodeURIComponent(csrf) }, entry);
    const adapter = new PiAiAdapter({ profiles: () => new Map([[CLOUD_MODEL_PROVIDER, profile]]),
      // 协议占位符不是凭证；服务器仅验证 Cookie/CSRF，不接受此 Bearer。
      resolveApiKey: async () => 'desktop-session', auth: EMPTY_AUTH });
    try {
      for await (const chunk of adapter.stream(options)) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          yield { ...chunk, reason: { kind: 'error', failure: { code: 'CLOUD_INFERENCE_UNAVAILABLE', message: '云端模型推理不可用，请检查登录、默认模型及云端推理服务。' } } };
        } else yield chunk;
      }
    } catch { throw new LlmError('云端模型推理不可用，请检查登录、默认模型及云端推理服务。', 'CLOUD_INFERENCE_UNAVAILABLE'); }
  }

  private isEnabled(): boolean { return this.options.enabled?.() ?? true; }

  /** 把目录条目与选择器互查收敛到一处；未知选择器与无默认的 cloud-default 在此分流。 */
  private entry(catalog: CloudModelCatalog, selector: string): CatalogEntry {
    if (selector === MODEL) {
      const profile = defaultProfile(catalog);
      if (!profile) throw new LlmError('云端账号尚未配置默认模型或密钥。', 'CLOUD_DEFAULT_MODEL_REQUIRED');
      return { selector, name: profile.displayName, description: `云端默认模型：${profile.defaultModel}` };
    }
    const account = /^account\/([^/]+)(?:\/(.+))?$/.exec(selector);
    if (account) {
      const profile = catalog.profiles.find(item => item.id === account[1] && item.keyConfigured);
      const model = account[2] ?? profile?.defaultModel;
      if (profile && model !== undefined && profile.modelIds.includes(model)) {
        return { selector, name: `${profile.displayName} · ${model}`, description: '账号私有模型' };
      }
      throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
    }
    const shared = /^shared\/([^/]+)\/(.+)$/.exec(selector);
    if (shared) {
      const entry = catalog.sharedModels.find(item => item.provider === shared[1] && item.model === shared[2]);
      if (entry) return { selector, name: entry.name, description: '部署共享模型' };
    }
    throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
  }

  private async catalog(): Promise<CloudModelCatalog> {
    const cookie = this.options.cookie();
    if (!hasSession(cookie)) throw new LlmError('请先在云端登录账号后再使用本地会话模型。', 'CLOUD_LOGIN_REQUIRED');
    const now = Date.now();
    if (this.cached && this.cached.cookie === cookie && this.cached.expiresAt > now) return this.cached.catalog;
    if (this.pending && this.pendingCookie === cookie) return this.pending;
    const pending = this.fetchCatalog(cookie);
    this.pending = pending;
    this.pendingCookie = cookie;
    // 清理回调不能再生成一个未被消费的 rejected promise。
    pending.then(() => this.clearPending(pending), () => this.clearPending(pending));
    return pending;
  }

  private clearPending(pending: Promise<CloudModelCatalog>): void {
    if (this.pending === pending) { this.pending = undefined; this.pendingCookie = undefined; }
  }

  private async fetchCatalog(cookie: string): Promise<CloudModelCatalog> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(new URL('/auth/models', this.options.origin), {
        headers: { accept: 'application/json', cookie },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch { throw new LlmError('云端模型配置暂不可用，请检查网络连接。', 'CLOUD_MODEL_UNAVAILABLE'); }
    if (response.status === 401 || response.status === 403) throw new LlmError('请先在云端登录账号后再使用本地会话模型。', 'CLOUD_LOGIN_REQUIRED');
    if (!response.ok) throw new LlmError('云端模型配置暂不可用，请稍后重试。', 'CLOUD_MODEL_UNAVAILABLE');
    let catalog: CloudModelCatalog;
    try { catalog = parseCatalog(await response.json()); } catch { throw new LlmError('云端模型配置响应无效。', 'CLOUD_MODEL_UNAVAILABLE'); }
    this.cached = { cookie, expiresAt: Date.now() + (this.options.catalogTtlMs ?? CATALOG_TTL_MS), catalog };
    return catalog;
  }
}

/** picker 条目：账号默认（无默认 profile 时不列，避免被默认选取命中）+ 每个私有 profile 的每个 modelId + 部署共享目录。 */
function catalogEntries(catalog: CloudModelCatalog): CatalogEntry[] {
  const profile = defaultProfile(catalog);
  const entries: CatalogEntry[] = [];
  if (profile) {
    entries.push({ selector: MODEL, name: profile.displayName, description: `云端默认模型：${profile.defaultModel}` });
  }
  for (const item of catalog.profiles) {
    if (!item.keyConfigured) continue;
    for (const model of item.modelIds) {
      entries.push({ selector: `account/${item.id}/${model}`, name: `${item.displayName} · ${model}`, description: '账号私有模型' });
    }
  }
  for (const item of catalog.sharedModels) {
    entries.push({ selector: `shared/${item.provider}/${item.model}`, name: item.name, description: '部署共享模型' });
  }
  return entries;
}

function defaultProfile(catalog: CloudModelCatalog): CloudModelProfile | undefined {
  return catalog.defaultProfileId === null ? undefined
    : catalog.profiles.find(item => item.id === catalog.defaultProfileId && item.keyConfigured);
}

function gatewayProfile(origin: string, headers: Record<string, string>, entry: CatalogEntry): ResolvedPiAiProviderProfile {
  const baseURL = `${origin}/auth/desktop-inference`;
  const model: Model<'openai-completions'> = { id: entry.selector, name: entry.name, api: 'openai-completions', provider: CLOUD_MODEL_PROVIDER,
    baseUrl: baseURL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS };
  return { provider: CLOUD_MODEL_PROVIDER, displayName: entry.name, api: 'openai-completions', baseURL, headers,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: NO_RETRY, configuredMaxTokens: new Map(), modelErrors: new Map(),
    piProvider: createProvider({ id: CLOUD_MODEL_PROVIDER, name: '云端账号模型', baseUrl: baseURL,
      auth: { apiKey: { name: '云端会话', resolve: async () => ({ auth: { apiKey: 'desktop-session' }, source: '云端会话' }) } },
      models: [model], api: openAICompletionsApi() }),
  } as ResolvedPiAiProviderProfile;
}

function hasSession(cookie: string): boolean {
  return /(?:^|;\s*)(?:__Host-dsh_session|dsh_session)=[^;]+/.test(cookie)
    && /(?:^|;\s*)dsh_csrf=[^;]+/.test(cookie);
}

function parseCatalog(value: unknown): CloudModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.profiles)) throw new Error('INVALID_CLOUD_MODEL_CATALOG');
  const defaultProfileId = value.defaultProfileId === null || value.defaultProfileId === undefined ? null : readString(value.defaultProfileId);
  const sharedModels = Array.isArray(value.sharedModels) ? value.sharedModels.map(parseSharedModel) : [];
  return { defaultProfileId, sharedModels, profiles: value.profiles.map(parseProfile) };
}

function parseProfile(value: unknown): CloudModelProfile {
  if (!isRecord(value) || Object.hasOwn(value, 'apiKey') || !Array.isArray(value.modelIds)) throw new Error('INVALID_CLOUD_MODEL_PROFILE');
  const modelIds = value.modelIds.map(readString).filter(Boolean);
  const profile = {
    id: readString(value.id), displayName: readString(value.displayName), baseUrl: readString(value.baseUrl),
    modelIds, defaultModel: readString(value.defaultModel), keyConfigured: value.keyConfigured === true,
  };
  if (!profile.id || !profile.displayName || !profile.baseUrl || !profile.defaultModel || !modelIds.includes(profile.defaultModel)) throw new Error('INVALID_CLOUD_MODEL_PROFILE');
  return profile;
}

/** provider 段不得含 `/`（否则选择器无法被服务端解析回原始条目）。 */
function parseSharedModel(value: unknown): CloudSharedModel {
  if (!isRecord(value) || Object.hasOwn(value, 'apiKey')) throw new Error('INVALID_CLOUD_MODEL_PROFILE');
  const entry = { provider: readString(value.provider), model: readString(value.model), name: readString(value.name) };
  if (!entry.provider || entry.provider.includes('/') || !entry.model || !entry.name) throw new Error('INVALID_CLOUD_MODEL_PROFILE');
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
