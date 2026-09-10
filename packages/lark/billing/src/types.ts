import type { TokenUsage } from "@deepseek-ai/dsh-llm";

import type { Scope } from "dsh-lark-contracts";

export const TOKENS_PER_MILLION = 1_000_000;
/** 内部精确金额单位：一美元拆成一百万个微美元；数据库旧列名保留兼容。 */
export const MICRO_USD_PER_USD = 1_000_000;

/** 额度策略按用户管理；账本仍保存完整 Scope（含 conversationId）。 */
export type BillingUserScope = Pick<Scope, "tenantId" | "botId" | "deploymentId" | "userId">;
export type BillingNamespace = Pick<Scope, "tenantId" | "botId" | "deploymentId">;

export interface DefaultModelPrice {
  inputMicroCreditsPerMillion: number;
  outputMicroCreditsPerMillion: number;
  cacheReadMicroCreditsPerMillion: number;
  cacheWriteMicroCreditsPerMillion: number;
  reasoningMicroCreditsPerMillion: number;
}

export interface ModelPrice extends DefaultModelPrice {
  provider: string;
  model: string;
  updatedAt: string;
}

export interface UsageInput {
  scope: Scope;
  runId: string;
  turn: number;
  step: number;
  provider: string;
  model: string;
  usage: TokenUsage;
  recordedAt?: Date;
}

export interface UsageCharge {
  id: string;
  scope: Scope;
  runId: string;
  turn: number;
  step: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  inputMicroCredits: number;
  outputMicroCredits: number;
  cacheReadMicroCredits: number;
  cacheWriteMicroCredits: number;
  reasoningMicroCredits: number;
  totalMicroCredits: number;
  periodStart: string;
  price: ModelPrice;
  recordedAt: string;
}

export interface QuotaSnapshot {
  scope: BillingUserScope;
  periodStart: string;
  monthlyLimitMicroCredits: number;
  usedMicroCredits: number;
  remainingMicroCredits: number;
}

export interface UsageAggregateFilter {
  scope: Scope;
  userId?: string;
  provider?: string;
  model?: string;
  from?: Date;
  to?: Date;
}

export interface UsageAggregate {
  periodStart: string;
  tenantId: string;
  botId: string;
  deploymentId: string;
  userId: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalMicroCredits: number;
}

export interface BillingStore {
  getPrice(provider: string, model: string): Promise<ModelPrice | undefined>;
  listPrices(): Promise<ModelPrice[]>;
  setPrice(price: ModelPrice): Promise<ModelPrice>;
  getQuotaPolicy(scope: BillingUserScope): Promise<number | undefined>;
  setQuotaPolicy(scope: BillingUserScope, limit: number): Promise<void>;
  findCharge(key: string): Promise<UsageCharge | undefined>;
  insertCharge(charge: UsageCharge): Promise<UsageCharge>;
  listCharges(filter: UsageAggregateFilter): Promise<UsageCharge[]>;
}

export function billingUserScope(scope: Scope): BillingUserScope {
  return {
    tenantId: scope.tenantId,
    botId: scope.botId,
    deploymentId: scope.deploymentId,
    userId: scope.userId,
  };
}

export function scopeKey(scope: Scope): string {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId, scope.conversationId].join("\0");
}

export function usageKey(input: Pick<UsageInput, "scope" | "runId" | "turn" | "step" | "provider" | "model">): string {
  return [scopeKey(input.scope), input.runId, input.turn, input.step, input.provider, input.model].join("\0");
}

export function periodStartFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

export function userScopeKey(scope: BillingUserScope): string {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId].join("\0");
}

export function assertSafeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`billing: ${label} 必须是非负安全整数`);
  return value;
}

/** 将用户可见的美元金额转换为内部微美元，最多保留 6 位小数。 */
export function usdToMicroCredits(value: number, label = "美元金额"): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`billing: ${label} 必须是非负有限数字`);
  const scaled = value * MICRO_USD_PER_USD;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-6) {
    throw new Error(`billing: ${label} 最多支持 6 位小数且必须在安全整数范围内`);
  }
  return rounded;
}

/** 将内部微美元转换为稳定的美元数字，避免向浏览器暴露内部单位。 */
export function microCreditsToUsd(value: number): number {
  return Number((assertSafeNonNegativeInteger(value, "微美元") / MICRO_USD_PER_USD).toFixed(6));
}

export function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`billing: ${label} 必须是正安全整数`);
  return value;
}
