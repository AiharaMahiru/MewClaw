/**
 * dsh-knowledge-postgres 插件入口（SPEC knowledge.md）。
 *
 * 装载期：解析数据库与嵌入凭证引用（缺失 fail loud）→ 建连接池 →
 * 跑迁移 → recoverInterrupted → ctx.provide("knowledge")。凭证不可热重载
 * （连接串/密钥变更需重启——凭据更新事件只发告警，不半吊子重建）。
 *
 * 密钥纪律：凭证引用只以 env 变量名出现，值绝不写入配置/日志。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { PostgresKnowledgeAdminService } from "./admin.js";
import { resolveKnowledgePipelineOptions } from "./config.js";
import { PgKnowledgeDatabase } from "./database.js";
import { SiliconFlowEmbeddingClient } from "./embedding.js";
import { PostgresKnowledgeIngestionService } from "./ingestion.js";
import { KNOWLEDGE_MIGRATIONS } from "./migrations.js";
import { KnowledgePipeline } from "./pipeline.js";
import { PostgresKnowledgeStore } from "./store.js";

export const name = "knowledge-postgres";

export const inject = ["credentials"];

export interface Config {
  /** 数据库连接串凭证引用（env 变量名）；缺失 fail loud。 */
  databaseUrlEnv: string;
  /** SiliconFlow API Key 凭证引用（env 变量名）；缺失 fail loud。 */
  siliconflowApiKeyEnv: string;
  /** 嵌入 API base URL（默认 https://api.siliconflow.cn/v1）。 */
  siliconflowBaseUrl?: string;
  /** 嵌入模型（默认 Qwen/Qwen3-VL-Embedding-8B，维度 1024）。 */
  embeddingModel?: string;
  /** 分块参数（默认 4000 字符 / 400 重叠）。 */
  chunking?: { maxCharacters: number; overlapCharacters: number };
  /** 检索默认（topK 5 / candidate 20 / rerank true）。 */
  retrieval?: { topK: number; candidateCount: number; rerank: boolean };
  /** 摄入并发上限（默认 2）。 */
  ingestionConcurrency?: number;
  /** 摄入源根目录（绝对路径；sourcePath 必须位于其 <scopeKey>/ 内）。 */
  uploadsRoot: string;
  /** 单文件大小上限（默认 100 MiB）。 */
  maxSourceBytes?: number;
}

export const Config: z<Config> = z.object({
  databaseUrlEnv: z.string().required(),
  siliconflowApiKeyEnv: z.string().required(),
  siliconflowBaseUrl: z.string(),
  embeddingModel: z.string(),
  chunking: z.object({
    maxCharacters: z.number(),
    overlapCharacters: z.number(),
  }),
  retrieval: z.object({
    topK: z.number(),
    candidateCount: z.number(),
    rerank: z.boolean(),
  }),
  ingestionConcurrency: z.number(),
  uploadsRoot: z.string().required(),
  maxSourceBytes: z.number(),
});

/**
 * async apply：装载期解析凭证 → 建池 → 迁移 → recoverInterrupted →
 * provide。fiber 在 apply 返回前保持 pending，loader 会等待本行激活
 * （下游 inject knowledge 的行因此不会在启动审计里报 pending）。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolvedOptions = resolveKnowledgePipelineOptions({
    chunkOptions: config.chunking,
    topK: config.retrieval?.topK,
    candidateCount: config.retrieval?.candidateCount,
    rerank: config.retrieval?.rerank,
    ingestionConcurrency: config.ingestionConcurrency,
    maxSourceBytes: config.maxSourceBytes,
  });
  /** 活跃守卫：dispose 后异步初始化不再 provide（防 INACTIVE_EFFECT）。 */
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });

  const resolveCredential = async (reference: string): Promise<string | undefined> => {
    const resolved = await ctx.credentials!.resolve(reference as CredentialRef);
    return resolved?.value;
  };

  const [databaseUrl, apiKey] = await Promise.all([
    resolveCredential(config.databaseUrlEnv),
    resolveCredential(config.siliconflowApiKeyEnv),
  ]);
  if (!databaseUrl || !apiKey) {
    throw new Error(
      `knowledge-postgres: 凭证引用未配置（${config.databaseUrlEnv} / ${config.siliconflowApiKeyEnv}）——密钥值绝不写入配置，请检查 .env 与凭证提供方`,
    );
  }
  const database = new PgKnowledgeDatabase(databaseUrl);
  await runMigrations(database, [...KNOWLEDGE_MIGRATIONS]);
  if (!active) {
    await database.close();
    return;
  }
  const embedding = new SiliconFlowEmbeddingClient({
    apiKey,
    ...(config.siliconflowBaseUrl ? { baseUrl: config.siliconflowBaseUrl } : {}),
  });
  const pipeline = new KnowledgePipeline({
    database,
    store: new PostgresKnowledgeStore(database),
    admin: new PostgresKnowledgeAdminService(database),
    ingestions: new PostgresKnowledgeIngestionService(database),
    embedding,
    ...(config.embeddingModel ? { embeddingModel: config.embeddingModel } : {}),
    chunkOptions: resolvedOptions.chunkOptions,
    topK: resolvedOptions.topK,
    candidateCount: resolvedOptions.candidateCount,
    rerank: resolvedOptions.rerank,
    ingestionConcurrency: resolvedOptions.ingestionConcurrency,
    uploadsRoot: config.uploadsRoot,
    maxSourceBytes: resolvedOptions.maxSourceBytes,
  });
  await pipeline.init();
  if (!active) {
    await database.close();
    return;
  }
  ctx.provide("knowledge", pipeline);
  // 清理效果同步注册（apply 返回前，防 INACTIVE_EFFECT）。
  ctx.effect(() => () => database.close());

  // 凭证不可热重载：只告警（连接串/嵌入密钥重建需重启，避免半可用状态）。
  ctx.on("credentials/reference-updated", (reference: CredentialRef) => {
    if (reference !== config.databaseUrlEnv && reference !== config.siliconflowApiKeyEnv) return;
    ctx.logger.warn("knowledge-postgres: 凭证变更需要重启生效（当前实例继续使用旧凭证）");
  });
}

export * from "./admin.js";
export * from "./chunker.js";
export * from "./database.js";
export * from "./embedding.js";
export * from "./identifiers.js";
export * from "./ingestion.js";
export * from "./migrations.js";
export * from "./pipeline.js";
export * from "./search-sql.js";
export * from "./store.js";
