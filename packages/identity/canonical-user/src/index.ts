import type { Context } from "@deepseek-ai/cordis";
import { credentialRef, type CredentialRef } from "@deepseek-ai/dsh-credentials";
import z from "@deepseek-ai/schemastery";

import { PgCanonicalUserDatabase } from "./database.js";
import { CANONICAL_USER_MIGRATIONS } from "./migrations.js";
import { PostgresCanonicalUserResolver } from "./postgres-store.js";
import { DefaultCanonicalUserService } from "./service.js";
import type { CanonicalUserResolver } from "./types.js";
import { runMigrations } from "dsh-lark-postgres-runtime";

export const name = "canonical-user";
export const inject = ["credentials"];

export interface Config {
  databaseUrlEnv: string;
}

export const Config: z<Config> = z.object({
  databaseUrlEnv: z.string().required(),
});

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** Web UUID 与飞书身份的统一计费归属解析器。 */
    canonicalUsers?: CanonicalUserResolver;
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  let active = true;
  ctx.effect(() => () => { active = false; });
  let reference: CredentialRef;
  try {
    reference = credentialRef(config.databaseUrlEnv);
  } catch {
    throw new Error("canonical-user: 数据库凭证引用无效");
  }
  const connectionString = await resolveDatabaseUrl(ctx, reference);
  if (!active) return;
  if (!connectionString) throw new Error("canonical-user: 数据库凭证引用未配置");
  const database = openDatabase(connectionString);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await database.close();
    } catch {
      throw new Error("canonical-user: PostgreSQL 关闭失败");
    }
  };
  ctx.effect(() => close);
  try {
    await runMigrations(database, CANONICAL_USER_MIGRATIONS);
  } catch {
    try { await close(); } catch { /* 初始化错误优先，且两类错误都不得携带连接细节。 */ }
    throw new Error("canonical-user: PostgreSQL 初始化失败");
  }
  if (!active) {
    await close();
    return;
  }
  ctx.provide("canonicalUsers", new DefaultCanonicalUserService(new PostgresCanonicalUserResolver(database)));
  ctx.on("credentials/reference-updated", (reference: CredentialRef) => {
    if (reference === config.databaseUrlEnv) ctx.logger.warn("canonical-user: 数据库凭证变更需要重启生效");
  });
}

async function resolveDatabaseUrl(ctx: Context, reference: CredentialRef): Promise<string | undefined> {
  try {
    return (await ctx.credentials!.resolve(reference))?.value;
  } catch {
    throw new Error("canonical-user: 数据库凭证解析失败");
  }
}

function openDatabase(connectionString: string): PgCanonicalUserDatabase {
  try {
    return new PgCanonicalUserDatabase(connectionString);
  } catch {
    throw new Error("canonical-user: PostgreSQL 初始化失败");
  }
}

export * from "./database.js";
export * from "./memory-store.js";
export * from "./migrations.js";
export * from "./postgres-store.js";
export * from "./service.js";
export * from "./types.js";
