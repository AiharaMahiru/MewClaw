import type { Context } from "@deepseek-ai/cordis";
import { credentialRef, type CredentialRef } from "@deepseek-ai/dsh-credentials";

import { Config as ConfigSchema, type Config as AuthConfig } from "./config.js";
import { FileCredentialRollbackStore } from "./credential-rollback-store.js";
import { DefaultAuthCapability } from "./import-service.js";
import { PgAuthImportPersistence, PostgresAuthImportStore } from "./postgres-import-store.js";

export const name = "auth";
export const inject = ["credentials"];
export const Config = ConfigSchema;
export type Config = AuthConfig;

export async function apply(ctx: Context, config: Config): Promise<void> {
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });

  const reference = parseCredentialRef(config.databaseUrlEnv);
  const rollbackKeyReference = parseCredentialRef(config.credentialRollbackKeyEnv);
  if (reference === rollbackKeyReference) {
    throw new Error("auth: 凭证回滚密钥不得复用数据库凭证引用");
  }
  const connectionString = await resolveDatabaseUrl(ctx, reference);
  if (!active) return;
  if (!connectionString) throw new Error("auth: 数据库凭证引用未配置");
  const rollbackKey = await resolveRollbackKey(ctx, rollbackKeyReference);
  if (!active) return;
  const rollbackStore = new FileCredentialRollbackStore(config.credentialRollbackPath, rollbackKey);
  let persistence: PgAuthImportPersistence;
  try {
    persistence = openPersistence(connectionString);
  } catch (error) {
    rollbackStore.close();
    throw error;
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    rollbackStore.close();
    await persistence.close();
  };

  try {
    ctx.effect(() => close);
  } catch (error) {
    try { await close(); } catch { /* Cordis 注册错误优先。 */ }
    throw error;
  }

  try {
    await persistence.migrate();
  } catch {
    try { await close(); } catch { /* 初始化错误优先，且两类错误都不得携带连接细节。 */ }
    throw new Error("auth: PostgreSQL 初始化失败");
  }
  if (!active) {
    await close();
    return;
  }
  try {
    const capability = new DefaultAuthCapability(new PostgresAuthImportStore(persistence), {
      approvalTtlMs: config.approvalTtlMs,
      credentialRollbackStore: rollbackStore,
    });
    ctx.provide("auth", capability);
    ctx.on("credentials/reference-updated", (updated: CredentialRef) => {
      if (updated !== reference) return;
      ctx.logger.warn("auth: 数据库凭证变更需要重启生效");
    });
  } catch (error) {
    try { await close(); } catch { /* Cordis 初始化错误优先。 */ }
    throw error;
  }
}

function parseCredentialRef(value: string): CredentialRef {
  try {
    return credentialRef(value);
  } catch {
    throw new Error("auth: 数据库凭证引用无效");
  }
}

async function resolveDatabaseUrl(ctx: Context, reference: CredentialRef): Promise<string | undefined> {
  try {
    return (await ctx.credentials!.resolve(reference))?.value;
  } catch {
    throw new Error("auth: 数据库凭证解析失败");
  }
}

async function resolveRollbackKey(ctx: Context, reference: CredentialRef): Promise<string> {
  try {
    const value = (await ctx.credentials!.resolve(reference))?.value;
    if (!value) throw new Error("missing");
    return value;
  } catch {
    throw new Error("auth: 凭证回滚密钥引用未配置或解析失败");
  }
}

function openPersistence(connectionString: string): PgAuthImportPersistence {
  try {
    return new PgAuthImportPersistence(connectionString);
  } catch {
    throw new Error("auth: PostgreSQL 初始化失败");
  }
}

export * from "./capability.js";
export * from "./config.js";
export * from "./credential-sync.js";
export * from "./credential-rollback-store.js";
export * from "./credential-policy.js";
export * from "./crypto.js";
export * from "./import-migrations.js";
export * from "./memory-store.js";
export * from "./migrations.js";
export * from "./policy.js";
export * from "./postgres-store.js";
export * from "./service.js";
export * from "./types.js";
export * from "./user-model-crypto.js";
