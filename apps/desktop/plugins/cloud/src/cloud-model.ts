/** 本地 Agent 使用云端认证推理网关；上游模型密钥始终留在服务器。 */
import { createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { LlmAdapter, LlmError, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter, type PiAiAdapterOptions, type ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';

export const CLOUD_MODEL_PROVIDER = 'mewclaw-cloud';
const MODEL = 'cloud-default';
const CONTEXT_WINDOW = 262144;
const MAX_TOKENS = 32768;
const NO_RETRY = { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 };
const EMPTY_AUTH: PiAiAdapterOptions['auth'] = {
  credentials: { async read() { return undefined; }, async list() { return []; }, async modify(_id, fn) { return fn(undefined); }, async delete() {} },
  authContext: { async env() { return undefined; }, async fileExists() { return false; } },
};

export class CloudAccountModel extends LlmAdapter {
  constructor(private readonly options: { origin: string; cookie(): string }) { super(); }
  override providerInfo() { return { id: CLOUD_MODEL_PROVIDER, name: '云端账号模型' }; }
  override async listModels() { return [this.info()]; }
  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model !== MODEL) throw new LlmError('云端模型选择无效', 'MODEL_NOT_FOUND');
    return this.info();
  }
  private info(): LlmResolvedModelInfo {
    return { provider: CLOUD_MODEL_PROVIDER, id: MODEL, name: '云端默认模型', inputModalities: ['text'], context: { contextWindow: CONTEXT_WINDOW } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cookie = this.options.cookie();
    const csrf = /(?:^|;\s*)dsh_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!csrf || !/(?:^|;\s*)(?:__Host-dsh_session|dsh_session)=/.test(cookie)) {
      throw new LlmError('请切换云端并登录账号后再使用本地模型。', 'CLOUD_LOGIN_REQUIRED');
    }
    const profile = gatewayProfile(this.options.origin, { cookie, origin: this.options.origin, 'x-csrf-token': decodeURIComponent(csrf) });
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
}

function gatewayProfile(origin: string, headers: Record<string, string>): ResolvedPiAiProviderProfile {
  const baseURL = `${origin}/auth/desktop-inference`;
  const model: Model<'openai-completions'> = { id: MODEL, name: '云端默认模型', api: 'openai-completions', provider: CLOUD_MODEL_PROVIDER,
    baseUrl: baseURL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS };
  return { provider: CLOUD_MODEL_PROVIDER, displayName: '云端账号模型', api: 'openai-completions', baseURL, headers,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20 * 1024 * 1024, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: NO_RETRY, configuredMaxTokens: new Map(), modelErrors: new Map(),
    piProvider: createProvider({ id: CLOUD_MODEL_PROVIDER, name: '云端账号模型', baseUrl: baseURL,
      auth: { apiKey: { name: '云端会话', resolve: async () => ({ auth: { apiKey: 'desktop-session' }, source: '云端会话' }) } },
      models: [model], api: openAICompletionsApi() }),
  } as ResolvedPiAiProviderProfile;
}
