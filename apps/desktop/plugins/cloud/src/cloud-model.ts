/** 本地会话的云端模型桥接；配置由云端账号决定，API Key 始终留在服务器。 */
import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { LlmAdapter, LlmError, ReasoningEffortId, type GenerateOptions, type LlmProviderInfo, type LlmResolvedModelInfo, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm';

export const CLOUD_MODEL_PROVIDER = 'mewclaw-cloud';
/** 与云端 Worker 相同的 provider id：会话选择（provider/model）在两种模式下完全一致。 */
export const PRIVATE_MODEL_PROVIDER = 'web-private';
const LEGACY_DEFAULT = 'cloud-default';
const CONTEXT_WINDOW = 262144;
const MAX_TOKENS = 32768;
const CATALOG_TTL_MS = 5000;
const NO_RETRY = { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
/** 官方默认集合补 STREAM_CLOSED（上游断流不发 [DONE]）与 CLOUD_INFERENCE_FAILED（Edge 5xx）——部署重启窗口的瞬态失败在步骤边界自动重试，语义错误仍即时上浮。 */
const CLOUD_RETRY_POLICY: ResolvedRetryPolicy = { mode: 'normal', maxRetries: 5, retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'CLOUD_INFERENCE_FAILED'], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
const EMPTY_AUTH: PiAiAdapterOptions['auth'] = {
  credentials: { async read() { return undefined; }, async list() { return []; }, async modify(_id, fn) { return fn(undefined); }, async delete() {} },
  authContext: { async env() { return undefined; }, async fileExists() { return false; } },
};
// 组名与云端 Worker 的 catalog 一致：官方适配器报 DeepSeek，pi-ai 系 provider 按原始 id 显示。
const SHARED_PROVIDER_NAMES: Record<string, string> = { 'deepseek-official': 'DeepSeek' };

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
  /** Edge 透传的服务端 resolved reasoning 元数据；缺省表示该模型不暴露强度选择。 */
  reasoningEfforts?: { id: string; name: string; description?: string }[];
  defaultReasoningEffort?: string;
}

interface CloudModelCatalog {
  profiles: CloudModelProfile[];
  sharedModels: CloudSharedModel[];
  defaultProfileId: string | null;
}

/** picker 展示的模型 id 与服务端路由选择器解耦：id 与云端同形，selector 发给 Edge。 */
interface CatalogEntry {
  id: string;
  selector: string;
  name: string;
  description: string;
  reasoning?: LlmResolvedModelInfo['reasoning'];
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
  private routes: string[] = [CLOUD_MODEL_PROVIDER];
  private registration: AdapterRegistrationHandle | undefined;
  private registeredProviders: (() => string[]) | undefined;

  constructor(private readonly options: {
    origin: string;
    cookie(): string;
    enabled?: () => boolean;
    fetch?: typeof globalThis.fetch;
    catalogTtlMs?: number;
  }) { super(); }

  override providerInfo(provider: string): LlmProviderInfo {
    if (provider === PRIVATE_MODEL_PROVIDER) return { id: provider, name: '我的模型' };
    if (provider === CLOUD_MODEL_PROVIDER) return { id: provider, name: '云端账号模型桥接' };
    return { id: provider, name: SHARED_PROVIDER_NAMES[provider] ?? provider };
  }

  /** 由 index.ts 接线：目录刷新后把注册路由原子替换为云端同构的 provider 集。 */
  bindRoutes(registration: AdapterRegistrationHandle, registeredProviders: () => string[]): void {
    this.registration = registration;
    this.registeredProviders = registeredProviders;
  }

  invalidateCatalog(): void { this.cached = undefined; }

  /** 目标路由集：web-private + 目录里的共享 provider + mewclaw-cloud（仅解析兼容，不列条目）。 */
  private desiredRoutes(catalog: CloudModelCatalog): string[] {
    return [PRIVATE_MODEL_PROVIDER, ...new Set(catalog.sharedModels.map(item => item.provider)), CLOUD_MODEL_PROVIDER];
  }

  /** 目录到达后原子换路由；与本地既有 provider 冲突的 id 跳过（共享条目不挤占本机适配器）。 */
  private syncRoutes(catalog: CloudModelCatalog): void {
    if (!this.registration || !this.registeredProviders) return;
    const held = new Set(this.routes);
    const taken = new Set(this.registeredProviders().filter(id => !held.has(id)));
    const next = this.desiredRoutes(catalog).filter(id => id === CLOUD_MODEL_PROVIDER || !taken.has(id));
    if (next.length === this.routes.length && next.every((id, index) => id === this.routes[index])) return;
    try { this.registration.replace(next); this.routes = next; } catch { /* 保留旧路由 */ }
  }

  override async listModels(provider: string) {
    if (!this.isEnabled() || !this.routes.includes(provider)) return [];
    // 初始只有 mewclaw-cloud 一路由：对它的 listModels 是目录拉取与路由扩展的引导点。
    let catalog: CloudModelCatalog;
    try { catalog = await this.catalog(); } catch { return []; }
    if (provider === CLOUD_MODEL_PROVIDER) return [];
    return provider === PRIVATE_MODEL_PROVIDER ? privateEntries(catalog) : sharedEntries(catalog, provider);
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!this.isEnabled()) throw new LlmError('当前模式未启用云端账号模型桥接。', 'MODEL_NOT_FOUND');
    return this.info(provider, this.resolve(provider, model, await this.catalog()));
  }

  /** 会话持久化的 (provider, model) → 服务端路由选择器；web-private 仅认默认 profile 的默认模型。 */
  private resolve(provider: string, model: string, catalog: CloudModelCatalog): CatalogEntry {
    if (provider === CLOUD_MODEL_PROVIDER) return this.legacy(catalog, model);
    if (provider === PRIVATE_MODEL_PROVIDER) {
      const profile = defaultProfile(catalog);
      if (!profile) throw new LlmError('云端账号尚未配置默认模型或密钥。', 'CLOUD_DEFAULT_MODEL_REQUIRED');
      if (model !== profile.defaultModel) throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
      return { id: model, selector: LEGACY_DEFAULT, name: model, description: `账号默认模型：${profile.displayName}` };
    }
    const shared = catalog.sharedModels.find(item => item.provider === provider && item.model === model);
    if (shared) return { id: model, selector: `shared/${provider}/${model}`, name: shared.name, description: '部署共享模型', reasoning: sharedReasoning(shared) };
    throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
  }

  /** 旧版 mewclaw-cloud/* 持久化选择的兼容解析：选择器即模型 id。 */
  private legacy(catalog: CloudModelCatalog, selector: string): CatalogEntry {
    if (selector === LEGACY_DEFAULT) {
      const profile = defaultProfile(catalog);
      if (!profile) throw new LlmError('云端账号尚未配置默认模型或密钥。', 'CLOUD_DEFAULT_MODEL_REQUIRED');
      return { id: selector, selector, name: profile.displayName, description: `云端默认模型：${profile.defaultModel}` };
    }
    const account = /^account\/([^/]+)(?:\/(.+))?$/.exec(selector);
    if (account) {
      const profile = catalog.profiles.find(item => item.id === account[1] && item.keyConfigured);
      const model = account[2] ?? profile?.defaultModel;
      if (profile && model !== undefined && profile.modelIds.includes(model)) {
        return { id: selector, selector, name: `${profile.displayName} · ${model}`, description: '账号私有模型' };
      }
      throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
    }
    const shared = /^shared\/([^/]+)\/(.+)$/.exec(selector);
    if (shared) {
      const entry = catalog.sharedModels.find(item => item.provider === shared[1] && item.model === shared[2]);
      if (entry) return { id: selector, selector, name: entry.name, description: '部署共享模型' };
    }
    throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
  }

  private info(provider: string, entry: CatalogEntry): LlmResolvedModelInfo {
    return {
      provider,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_TOKENS,
      ...entry.reasoning === undefined ? {} : { reasoning: entry.reasoning },
    };
  }

  /** 桥接路由注册时捕获的重试策略：对齐生产 Worker 的瞬态集合（含 STREAM_CLOSED/CLOUD_INFERENCE_FAILED）。 */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return CLOUD_RETRY_POLICY;
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
    const entry = this.resolve(options.provider, options.model, await this.catalog());
    const profile = gatewayProfile(this.options.origin, { cookie, origin: this.options.origin, 'x-csrf-token': decodeURIComponent(csrf) }, entry);
    const adapter = new PiAiAdapter({ profiles: () => new Map([[CLOUD_MODEL_PROVIDER, profile]]),
      // 协议占位符不是凭证；服务器仅验证 Cookie/CSRF，不接受此 Bearer。
      resolveApiKey: async () => 'desktop-session', auth: EMPTY_AUTH });
    try {
      for await (const chunk of adapter.stream({ ...options, provider: CLOUD_MODEL_PROVIDER, model: entry.selector })) {
        if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
          yield { ...chunk, reason: { kind: 'error', failure: cloudFailure(chunk.reason.failure) } };
        } else yield chunk;
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const failure = cloudFailure(error instanceof LlmError ? { code: error.code, message: error.message }
        : { message: error instanceof Error ? error.message : String(error) });
      throw new LlmError(failure.message, failure.code);
    }
  }

  private isEnabled(): boolean { return this.options.enabled?.() ?? true; }

  /** 进入本地模式时的默认选择：默认私有模型 → 首个共享模型 → 旧 cloud-default（无可用项时保留错误面）。 */
  defaultSelection(catalog: CloudModelCatalog): { provider: string; model: string } {
    const profile = defaultProfile(catalog);
    if (profile) return { provider: PRIVATE_MODEL_PROVIDER, model: profile.defaultModel };
    const shared = catalog.sharedModels[0];
    if (shared) return { provider: shared.provider, model: shared.model };
    return { provider: CLOUD_MODEL_PROVIDER, model: LEGACY_DEFAULT };
  }

  /** 目录失败时返回 undefined，调用方自行决定默认选择回退。 */
  async catalogSnapshot(): Promise<CloudModelCatalog | undefined> {
    try { return await this.catalog(); } catch { return undefined; }
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
    this.syncRoutes(catalog);
    return catalog;
  }
}

/** web-private 只列默认 profile 的默认模型：云端私有路由只解析默认项，多列会造成静默替换。 */
function privateEntries(catalog: CloudModelCatalog): LlmResolvedModelInfo[] {
  const profile = defaultProfile(catalog);
  if (!profile) return [];
  return [{
    provider: PRIVATE_MODEL_PROVIDER, id: profile.defaultModel, name: profile.defaultModel,
    description: `账号默认模型：${profile.displayName}`, inputModalities: ['text'],
    context: { contextWindow: CONTEXT_WINDOW }, defaultMaxTokens: MAX_TOKENS,
  }];
}

function sharedEntries(catalog: CloudModelCatalog, provider: string): LlmResolvedModelInfo[] {
  return catalog.sharedModels.filter(item => item.provider === provider).map(item => {
    const reasoning = sharedReasoning(item);
    return {
      provider, id: item.model, name: item.name, description: '部署共享模型',
      inputModalities: ['text'], context: { contextWindow: CONTEXT_WINDOW }, defaultMaxTokens: MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    };
  });
}

/**
 * 服务端下发的强度表 → Harness reasoning 元数据。`off` 经 pi-ai 只能在请求里表达为
 * `reasoning_effort:"off"`（见 thinkingLevelMap），而它只在会话已固化默认值后可达：
 * 无默认值的模型若仍展示 off，未选强度的请求会被静默改写成"关闭思考"——此时摘掉 off 档。
 */
function sharedReasoning(item: CloudSharedModel): CatalogEntry['reasoning'] {
  const efforts = item.reasoningEfforts;
  if (!efforts || efforts.length === 0) return undefined;
  const hasDefault = item.defaultReasoningEffort !== undefined && efforts.some(e => e.id === item.defaultReasoningEffort);
  const visible = hasDefault ? efforts : efforts.filter(e => e.id !== 'off');
  if (visible.length === 0) return undefined;
  return {
    efforts: visible.map(e => ({ id: ReasoningEffortId(e.id), name: e.name, ...e.description === undefined ? {} : { description: e.description } })),
    ...hasDefault ? { defaultEffort: ReasoningEffortId(item.defaultReasoningEffort!) } : {},
  };
}

function defaultProfile(catalog: CloudModelCatalog): CloudModelProfile | undefined {
  return catalog.defaultProfileId === null ? undefined
    : catalog.profiles.find(item => item.id === catalog.defaultProfileId && item.keyConfigured);
}

function gatewayProfile(origin: string, headers: Record<string, string>, entry: CatalogEntry): ResolvedPiAiProviderProfile {
  const baseURL = `${origin}/auth/desktop-inference`;
  // Edge 白名单直接吃强度词（off/minimal/low/medium/high/xhigh/max），map 恒等即够；
  // 'off' 必须有映射：pi-ai 把选中 off 剥成"不带强度"，回落分支再按 map.off 发出。
  const thinkingLevelMap = entry.reasoning === undefined ? undefined
    : Object.fromEntries(entry.reasoning.efforts.map(e => [e.id, e.id]));
  const model: Model<'openai-completions'> = { id: entry.selector, name: entry.name, api: 'openai-completions', provider: CLOUD_MODEL_PROVIDER,
    baseUrl: baseURL, reasoning: entry.reasoning !== undefined, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap } };
  return { provider: CLOUD_MODEL_PROVIDER, displayName: entry.name, api: 'openai-completions', baseURL, headers,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: NO_RETRY, configuredMaxTokens: new Map(), modelErrors: new Map(),
    piProvider: createProvider({ id: CLOUD_MODEL_PROVIDER, name: '云端账号模型', baseUrl: baseURL,
      auth: { apiKey: { name: '云端会话', resolve: async () => ({ auth: { apiKey: 'desktop-session' }, source: '云端会话' }) } },
      models: [model], api: openAICompletionsApi() }),
  } as ResolvedPiAiProviderProfile;
}

/** 快照 cookie 是否构成一次可用的云端会话（桥接目录与推理都以它为门槛）。 */
export function hasSession(cookie: string): boolean {
  return /(?:^|;\s*)(?:__Host-dsh_session|dsh_session)=[^;]+/.test(cookie)
    && /(?:^|;\s*)dsh_csrf=[^;]+/.test(cookie);
}

/**
 * Edge `sendError` 产出 `{"error":"CODE"}`，pi-ai 以 `<status>: <body>` 带进 failure.message。
 * 语义码原样透传（与本类自抛的 CLOUD_* 同一套用户指引）；HTTP 状态与 pi-ai 分类码兜底；
 * TRANSPORT/STREAM_CLOSED 保留原码供 llm-retry 在步骤边界重试；真正未知的才收敛为通用码。
 */
const EDGE_ERROR_MESSAGES: Record<string, { code: string; message: string }> = {
  PROMPT_AUDIT_REJECTED: { code: 'PROMPT_AUDIT_REJECTED', message: '云端安全审计拒绝了本次请求，请调整输入后重试。' },
  MODEL_UNAVAILABLE: { code: 'MODEL_UNAVAILABLE', message: '所选模型在云端不可用，请重新选择模型。' },
  CLOUD_DEFAULT_MODEL_REQUIRED: { code: 'CLOUD_DEFAULT_MODEL_REQUIRED', message: '云端账号尚未配置默认模型或密钥。' },
  CLOUD_INFERENCE_FAILED: { code: 'CLOUD_INFERENCE_FAILED', message: '云端推理服务暂时失败，请稍后重试。' },
  INVALID_INFERENCE_REQUEST: { code: 'INVALID_INFERENCE_REQUEST', message: '云端推理请求内容不被当前模型支持。' },
};

function cloudFailure(failure: { code?: string | undefined; message?: string | undefined; status?: number | undefined } | undefined): { code: string; message: string } {
  const text = failure?.message ?? '';
  // pi-ai 会把 Edge 的 {"error":"CODE"} 解包成 `<status> "CODE"` 带进 message；两种形态都认。
  const edge = /"error"\s*:\s*"([A-Z0-9_]+)"/u.exec(text)?.[1] ?? /"([A-Z][A-Z0-9_]{5,})"/u.exec(text)?.[1];
  const known = edge === undefined ? undefined : EDGE_ERROR_MESSAGES[edge];
  if (known) return known;
  const statusMatch = /\b([45]\d\d)\b/u.exec(text)?.[1];
  const status = failure?.status ?? (statusMatch === undefined ? undefined : Number(statusMatch));
  if (edge === 'CSRF_INVALID' || edge === 'UNAUTHORIZED' || status === 401 || status === 403 || failure?.code === 'AUTH')
    return { code: 'CLOUD_LOGIN_REQUIRED', message: '云端会话已失效，请重新登录云端账号。' };
  if (status === 404) return EDGE_ERROR_MESSAGES['MODEL_UNAVAILABLE']!;
  if (status === 409) return EDGE_ERROR_MESSAGES['CLOUD_DEFAULT_MODEL_REQUIRED']!;
  if (status === 429 || failure?.code === 'RATE_LIMIT') return { code: 'RATE_LIMIT', message: '云端推理请求过多，请稍后重试。' };
  if ((status !== undefined && status >= 500) || failure?.code === 'SERVER') return EDGE_ERROR_MESSAGES['CLOUD_INFERENCE_FAILED']!;
  if (failure?.code === 'TIMEOUT') return { code: 'TIMEOUT', message: '云端推理请求超时，请稍后重试。' };
  // pi-ai 对上游断流报 TRANSPORT/"Stream ended without"；统一为 STREAM_CLOSED 与 llm-retry 约定一致。
  if (failure?.code === 'STREAM_CLOSED' || /stream ended (?:before|without)/iu.test(text))
    return { code: 'STREAM_CLOSED', message: '云端推理连接中断，请重试。' };
  if (failure?.code === 'TRANSPORT' || /fetch failed|ECONN[A-Z]+|network|connection|terminated|premature close/iu.test(text))
    return { code: 'TRANSPORT', message: '云端推理连接失败，请检查网络后重试。' };
  if (failure?.code === 'CONTEXT_WINDOW_EXCEEDED' || failure?.code === 'EMPTY_RESPONSE') return { code: failure.code, message: text };
  return { code: 'CLOUD_INFERENCE_UNAVAILABLE', message: '云端模型推理不可用，请检查登录、默认模型及云端推理服务。' };
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
  const entry: CloudSharedModel = { provider: readString(value.provider), model: readString(value.model), name: readString(value.name) };
  if (!entry.provider || entry.provider.includes('/') || !entry.model || !entry.name) throw new Error('INVALID_CLOUD_MODEL_PROFILE');
  if (Array.isArray(value.reasoningEfforts)) {
    const efforts = value.reasoningEfforts.map(parseEffort).filter((e): e is NonNullable<typeof e> => e !== undefined);
    if (efforts.length > 0) {
      entry.reasoningEfforts = efforts;
      const defaultEffort = readString(value.defaultReasoningEffort);
      if (defaultEffort) entry.defaultReasoningEffort = defaultEffort;
    }
  }
  return entry;
}

function parseEffort(value: unknown): { id: string; name: string; description?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const name = readString(value.name);
  if (!id || !name) return undefined;
  const description = readString(value.description);
  return description === '' ? { id, name } : { id, name, description };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
