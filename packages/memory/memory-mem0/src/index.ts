/**
 * dsh-memory-mem0 Provider。
 *
 * PostgreSQL 图表是可见事实源，Mem0 只负责语义索引；所有写入先经
 * MemScheduler 排队，模型运行不被网络/LLM 写入阻塞。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { runMigrations } from "dsh-lark-postgres-runtime";
import type {
  MemoryCapture,
  MemoryHit,
  MemoryPart,
  MemoryService,
  MemoryCommand,
} from "dsh-memory";

import { assertMetadata, assertParts } from "./content.js";
import { PgMemoryDatabase } from "./database.js";
import { MemoryGraphStore, type Mem0ClientPort } from "./graph.js";
import { memoryScopeIds, migrateMemoryUserKeys } from "./identifiers.js";
import { MEMORY_MIGRATIONS } from "./migrations.js";
import { MemoryWriteScheduler, type MemorySchedulerConfig } from "./scheduler.js";

export const name = "memory-mem0";
export const inject = ["credentials"];

export interface Config {
  enabled?: boolean;
  embeddingApiKeyEnv?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  llmApiKeyEnv?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  databaseUrlEnv?: string;
  collectionName?: string;
  scheduler?: Partial<MemorySchedulerConfig>;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean(),
  embeddingApiKeyEnv: z.string(),
  embeddingBaseUrl: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number(),
  llmApiKeyEnv: z.string(),
  llmModel: z.string(),
  llmBaseUrl: z.string(),
  databaseUrlEnv: z.string(),
  collectionName: z.string(),
  scheduler: z.object({
    concurrency: z.number(), pollIntervalMs: z.number(), maxAttempts: z.number(), leaseMs: z.number(),
  }),
});

const DEFAULT_CONFIG = {
  embeddingBaseUrl: "https://api.siliconflow.cn/v1",
  embeddingModel: "Qwen/Qwen3-VL-Embedding-8B",
  embeddingDimensions: 1024,
  llmModel: "deepseek-chat",
  llmBaseUrl: "https://api.deepseek.com",
  collectionName: "dsh_lark_memory",
} as const;

const DEFAULT_SCHEDULER: MemorySchedulerConfig = {
  concurrency: 4, pollIntervalMs: 250, maxAttempts: 5, leaseMs: 30_000,
};

function sdkConfig(config: Required<Pick<Config, "embeddingBaseUrl" | "embeddingModel" | "embeddingDimensions" | "llmModel" | "llmBaseUrl" | "collectionName">>, secrets: { embeddingApiKey: string; llmApiKey: string; databaseUrl: string }): Record<string, unknown> {
  return {
    embedder: { provider: "openai", config: { apiKey: secrets.embeddingApiKey, baseURL: config.embeddingBaseUrl, model: config.embeddingModel, embeddingDims: config.embeddingDimensions } },
    vectorStore: { provider: "pgvector", config: { connectionString: secrets.databaseUrl, collectionName: config.collectionName, embeddingModelDims: config.embeddingDimensions, hnsw: true } },
    llm: { provider: "openai", config: { apiKey: secrets.llmApiKey, model: config.llmModel, temperature: 0, baseURL: config.llmBaseUrl } },
    disableHistory: true,
  };
}

function conversationCommand(userText: string, assistantText: string, capture?: MemoryCapture): MemoryCommand {
  const parts: MemoryPart[] = capture?.parts?.length
    ? capture.parts
    : [{ modality: "text", text: `用户：${userText}\n助手：${assistantText.slice(0, 100_000)}` }];
  assertParts(parts);
  assertMetadata(capture?.metadata);
  return {
    op: "create",
    node: {
      ...(capture?.cubeId ? { cubeId: capture.cubeId } : {}),
      kind: capture?.kind ?? "episode", parts,
      ...(capture?.metadata ? { metadata: capture.metadata } : {}),
      source: capture?.source ?? { kind: "conversation" },
    },
  };
}

/** 兼容旧的纯 Mem0 单测/第三方 Provider 注入。 */
export function createMem0Service(client: Mem0ClientPort, logger: { warn(message: string): void }): MemoryService {
  return {
    enabled: () => true,
    async execute(): Promise<never> { throw new Error("MEMORY_GRAPH_UNAVAILABLE"); },
    async feedback(): Promise<never> { throw new Error("MEMORY_GRAPH_UNAVAILABLE"); },
    async recall(scope, query): Promise<MemoryHit[]> {
      try {
        const ids = memoryScopeIds(scope);
        const response = await client.search(query, { filters: { user_id: ids.userId, agent_id: ids.agentId }, topK: 8 });
        return response.results.slice(0, 8)
          .map((item, rank) => ({ content: item.memory.trim().slice(0, 10_000), rank, ...(item.score === undefined ? {} : { score: item.score }) }))
          .filter((item) => item.content.length > 0);
      } catch {
        return [];
      }
    },
    async remember(scope, userText, assistantText): Promise<void> {
      try {
        const ids = memoryScopeIds(scope);
        await client.add([
          { role: "user", content: userText },
          { role: "assistant", content: assistantText.slice(0, 100_000) },
        ], { ...ids, metadata: { conversation_id: scope.conversationId }, infer: true });
      } catch {
        logger.warn("memory-mem0: 兼容写入失败（已降级）");
      }
    },
  };
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) {
    const disabled: MemoryService = {
      enabled: () => false,
      execute: async () => { throw new Error("MEMORY_DISABLED"); },
      recall: async () => [],
      remember: async () => undefined,
      feedback: async () => { throw new Error("MEMORY_DISABLED"); },
    };
    ctx.provide("memory", disabled);
    return;
  }

  const get = async (reference: string | undefined): Promise<string | undefined> => (
    reference ? (await ctx.credentials!.resolve(reference as CredentialRef))?.value : undefined
  );
  const [embeddingApiKey, llmApiKey, databaseUrl] = await Promise.all([
    get(config.embeddingApiKeyEnv), get(config.llmApiKeyEnv), get(config.databaseUrlEnv),
  ]);
  const missing = [
    !embeddingApiKey && "embeddingApiKeyEnv",
    !llmApiKey && "llmApiKeyEnv",
    !databaseUrl && "databaseUrlEnv",
  ].filter((value): value is string => Boolean(value));
  if (missing.length > 0) throw new Error(`memory-mem0: 凭证引用未配置（${missing.join("/")}）`);

  const resolved = {
    embeddingBaseUrl: config.embeddingBaseUrl ?? DEFAULT_CONFIG.embeddingBaseUrl,
    embeddingModel: config.embeddingModel ?? DEFAULT_CONFIG.embeddingModel,
    embeddingDimensions: config.embeddingDimensions ?? DEFAULT_CONFIG.embeddingDimensions,
    llmModel: config.llmModel ?? DEFAULT_CONFIG.llmModel,
    llmBaseUrl: config.llmBaseUrl ?? DEFAULT_CONFIG.llmBaseUrl,
    collectionName: config.collectionName ?? DEFAULT_CONFIG.collectionName,
  };
  const { Memory } = await import("mem0ai/oss");
  const client = new Memory(sdkConfig(resolved, {
    embeddingApiKey: embeddingApiKey!, llmApiKey: llmApiKey!, databaseUrl: databaseUrl!,
  })) as unknown as Mem0ClientPort;
  const database = new PgMemoryDatabase(databaseUrl!);
  await runMigrations(database, [...MEMORY_MIGRATIONS]);
  await migrateMemoryUserKeys(database);
  const graph = new MemoryGraphStore(database, client, ctx.logger);
  const scheduler = new MemoryWriteScheduler(database, (scope, command) => graph.execute(scope, command), ctx.logger, {
    ...DEFAULT_SCHEDULER, ...config.scheduler,
  });
  await scheduler.start();

  const service: MemoryService = {
    enabled: () => true,
    execute: (scope, command) => graph.execute(scope, command),
    recall: (scope, query) => graph.recall(scope, query),
    remember: async (scope, userText, assistantText, capture) => scheduler.enqueue(scope, conversationCommand(userText, assistantText, capture)),
    feedback: (scope, instruction, cubeId) => graph.feedback(scope, instruction, cubeId),
  };
  ctx.provide("memory", service);
  ctx.effect(() => () => {
    void scheduler.stop().finally(() => { void database.close(); });
  });
  ctx.on("credentials/reference-updated", (reference: CredentialRef) => {
    if ([config.embeddingApiKeyEnv, config.llmApiKeyEnv, config.databaseUrlEnv].includes(reference)) {
      ctx.logger.warn("memory-mem0: 凭证变更需要重启生效");
    }
  });
}

export { MemoryGraphStore } from "./graph.js";
export { MemoryWriteScheduler } from "./scheduler.js";
export { memoryScopeIds } from "./identifiers.js";
export * from "./migrations.js";
export type { Mem0ClientPort } from "./graph.js";
