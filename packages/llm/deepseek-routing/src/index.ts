import type { Context } from "@deepseek-ai/cordis";
import { getOrCreateAnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import type {} from "@deepseek-ai/dsh-credentials";
import type {} from "@deepseek-ai/dsh-deepseek-llm-api-extensions";
import type {} from "@deepseek-ai/dsh-fs";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { assertUsableApiKey, LlmAdapter, LlmError, resolveImageAttachmentAccess, type GenerateOptions, type LlmModelInfo, type LlmProviderInfo, type LlmResolvedModelInfo, type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { Config as OfficialConfig, DeepSeekAdapter, resolveAdapterOptions, type Config as OfficialDeepSeekConfig, type DeepSeekConnectionOptions } from "@deepseek-ai/dsh-llm-deepseek";
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

const PROVIDER = "deepseek-official";
const SETTINGS_NS = "llm-deepseek";
const DEFAULT_ALIASES = { "deepseek-v4-flash": "deepseek-v4.1-flash-expires-on-0910" } as const;
const DEFAULT_DISABLED_MODELS = ["deepseek-v4-flash-vision-exp"] as const;

export interface Config extends OfficialDeepSeekConfig {
  modelAliases?: Record<string, string>;
  disabledModels?: string[];
}

export const Config: z<Config> = z.intersect([
  OfficialConfig,
  z.object({
    modelAliases: z.dict(z.string().min(1)).default({ ...DEFAULT_ALIASES }),
    disabledModels: z.array(z.string().min(1)).default([...DEFAULT_DISABLED_MODELS]),
  }),
]);
export const name = "lark-deepseek-routing";
export const inject = ["llm"];

interface RoutingSnapshot {
  connection: DeepSeekConnectionOptions;
  aliases: Readonly<Record<string, string>>;
  disabled: ReadonlySet<string>;
  visibleModels: ReadonlySet<string>;
}

/** 仅处理逻辑/wire ID；传输、图片、Files API、thinking、重试均委托官方 Adapter。 */
export class RoutedDeepSeekAdapter extends LlmAdapter {
  constructor(private readonly delegate: DeepSeekAdapter, private readonly snapshot: () => RoutingSnapshot) { super(); }
  override providerInfo(provider: string): LlmProviderInfo { return this.delegate.providerInfo(provider); }
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy { return this.delegate.providerRetryPolicy(provider); }
  override imageRequestPricing(provider: string, model: string): ReturnType<LlmAdapter["imageRequestPricing"]> {
    this.assertEnabled(model, this.snapshot());
    return this.delegate.imageRequestPricing(provider, model);
  }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const state = this.snapshot();
    return (await this.delegate.listModels(provider)).filter((model) => state.visibleModels.has(model.id));
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    this.assertEnabled(model, this.snapshot());
    return this.delegate.resolveModel(provider, model, signal);
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const state = this.snapshot();
    this.assertEnabled(model, state);
    const logicalModel = await this.delegate.resolveModel(provider, model, signal);
    const prepared = await this.delegate.prepareCall(provider, this.wireModel(model, state), signal);
    return { model: logicalModel, stream: (options) => prepared.stream({ ...options, model: this.wireModel(options.model, state) }) };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const state = this.snapshot();
    this.assertEnabled(options.model, state);
    yield* this.delegate.stream({ ...options, model: this.wireModel(options.model, state) });
  }
  private wireModel(model: string, state: RoutingSnapshot): string {
    const wire = state.aliases[model] ?? model;
    this.assertEnabled(wire, state);
    return wire;
  }
  private assertEnabled(model: string, state: RoutingSnapshot): void {
    if (state.disabled.has(model)) throw new LlmError(`DeepSeek model "${model}" is disabled.`, "MODEL_DISABLED");
  }
}

export function apply(ctx: Context, config: Config): void {
  let current = (): Config => config;
  let lastRaw: Config | undefined;
  let lastGood: RoutingSnapshot | undefined;
  const snapshot = (): RoutingSnapshot => {
    const raw = current();
    if (raw === lastRaw && lastGood) return lastGood;
    try {
      const next = resolveRoutingSnapshot(raw, ctx);
      lastRaw = raw;
      return lastGood = next;
    } catch (error) {
      if (!lastGood) throw error;
      lastRaw = raw;
      ctx.logger.error("lark-deepseek-routing: invalid settings; keeping the last good route");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  snapshot();
  const official = new DeepSeekAdapter({
    options: () => snapshot().connection,
    resolveApiKey: async (connection) => {
      const credentials = ctx.get("credentials");
      const hit = credentials ? await credentials.resolve(connection.apiKeyEnv) : launchEnvironmentOf(ctx).get(connection.apiKeyEnv);
      if (hit?.value) return assertUsableApiKey(hit.value, name, connection.apiKeyEnv);
      throw new LlmError(`lark-deepseek-routing: no API key for ${connection.apiKeyEnv}`, "MISSING_CREDENTIAL");
    },
    resolveUserId: () => getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
    prepareExtensions: (request) => ctx.get("deepseekLlmApiExtensions")?.prepare(request) ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() }),
  });
  const adapter = new RoutedDeepSeekAdapter(official, snapshot);
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "DeepSeek", settingsNs: SETTINGS_NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let retryPolicy = snapshot().connection.retryPolicy;
  const refreshRegistration = () => {
    const next = snapshot().connection.retryPolicy;
    if (JSON.stringify(next) === JSON.stringify(retryPolicy)) return;
    registration.replace([PROVIDER]);
    retryPolicy = next;
  };
  ctx.inject(["settings"], (settingsCtx) => settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, config, {
    setSource: (source) => { current = source; },
    onChange: refreshRegistration,
  }));
}

function resolveRoutingSnapshot(config: Config, ctx: Context): RoutingSnapshot {
  const { modelAliases = { ...DEFAULT_ALIASES }, disabledModels = [...DEFAULT_DISABLED_MODELS], ...officialConfig } = config;
  const disabled = new Set(disabledModels);
  const aliases = Object.freeze({ ...modelAliases });
  for (const [logical, wire] of Object.entries(aliases)) {
    if (disabled.has(logical) || disabled.has(wire)) throw new Error(`lark-deepseek-routing: disabled alias ${logical} -> ${wire}`);
  }
  const base = resolveAdapterOptions(officialConfig, launchEnvironmentOf(ctx));
  const visible = base.models.filter((model) => !disabled.has(model.id));
  const models = [...visible];
  const known = new Set(models.map((model) => model.id));
  for (const model of visible) {
    const wire = aliases[model.id];
    if (!wire || known.has(wire)) continue;
    models.push({ ...model, id: wire });
    known.add(wire);
  }
  return { connection: { ...base, models }, aliases, disabled, visibleModels: new Set(visible.map((model) => model.id)) };
}
