import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";

import "dsh-lark-contracts";
import { runMigrations } from "dsh-lark-postgres-runtime";

import { Config as ConfigSchema, resolveBillingConfig, type BillingConfig } from "./config.js";
import { PgBillingDatabase } from "./database.js";
import { BILLING_MIGRATIONS } from "./migrations.js";
import { PostgresBillingStore } from "./postgres-store.js";
import { DefaultBillingService, type BillingService } from "./service.js";

export const name = "lark-billing";
export const inject = ["credentials"];
export const Config = ConfigSchema;
export type { BillingConfig } from "./config.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    billing?: BillingService;
  }
}

export async function apply(ctx: Context, input: BillingConfig): Promise<void> {
  const config = resolveBillingConfig(input);
  let active = true;
  ctx.effect(() => () => {
    active = false;
  });
  const credential = await ctx.credentials!.resolve(config.databaseUrlEnv as CredentialRef);
  if (!credential?.value) throw new Error(`lark-billing: 凭证引用未配置（${config.databaseUrlEnv}）`);
  const database = new PgBillingDatabase(credential.value);
  await runMigrations(database, [...BILLING_MIGRATIONS]);
  if (!active) {
    await database.close();
    return;
  }
  const service = new DefaultBillingService(
    new PostgresBillingStore(database),
    config.defaultMonthlyLimitMicroCredits,
    config.defaultPrice,
    config.defaultPrices,
    config.namespace,
  );
  ctx.provide("billing", service);
  ctx.effect(() => () => database.close());
}

export * from "./config.js";
export * from "./database.js";
export * from "./memory-store.js";
export * from "./migrations.js";
export * from "./postgres-store.js";
export * from "./pricing.js";
export * from "./service.js";
export * from "./types.js";
