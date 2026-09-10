import { randomUUID } from "node:crypto";

import type {
  BillingStore,
  BillingUserScope,
  ModelPrice,
  UsageAggregateFilter,
  UsageCharge,
} from "./types.js";
import type { Scope } from "dsh-lark-contracts";
import type { QuotaSnapshot } from "./types.js";
import { periodStartFor, usageKey, userScopeKey } from "./types.js";

function sameAnchor(scope: Scope, filter: UsageAggregateFilter): boolean {
  return scope.tenantId === filter.scope.tenantId
    && scope.botId === filter.scope.botId
    && scope.deploymentId === filter.scope.deploymentId
    && (!filter.userId || scope.userId === filter.userId);
}

/** 测试与 boot-check 使用的确定性内存存储，不持久化密钥或凭证。 */
export class MemoryBillingStore implements BillingStore {
  readonly #prices = new Map<string, ModelPrice>();
  readonly #quotas = new Map<string, number>();
  readonly #charges = new Map<string, UsageCharge>();

  constructor(private readonly defaultMonthlyLimitMicroCredits: number) {}

  async getPrice(provider: string, model: string): Promise<ModelPrice | undefined> {
    return this.#prices.get(`${provider}\0${model}`);
  }

  async listPrices(): Promise<ModelPrice[]> {
    return [...this.#prices.values()].map((price) => ({ ...price }));
  }

  async setPrice(price: ModelPrice): Promise<ModelPrice> {
    this.#prices.set(`${price.provider}\0${price.model}`, { ...price });
    return { ...price };
  }

  async getQuotaPolicy(scope: BillingUserScope): Promise<number | undefined> {
    return this.#quotas.get(userScopeKey(scope));
  }

  async setQuotaPolicy(scope: BillingUserScope, limit: number): Promise<void> {
    this.#quotas.set(userScopeKey(scope), limit);
  }

  async findCharge(key: string): Promise<UsageCharge | undefined> {
    const charge = this.#charges.get(key);
    return charge ? cloneCharge(charge) : undefined;
  }

  async insertCharge(charge: UsageCharge): Promise<UsageCharge> {
    const key = usageKey(charge);
    const existing = this.#charges.get(key);
    if (existing) return cloneCharge(existing);
    const withId = { ...charge, id: charge.id || randomUUID() };
    this.#charges.set(key, cloneCharge(withId));
    return cloneCharge(withId);
  }

  async listCharges(filter: UsageAggregateFilter): Promise<UsageCharge[]> {
    return [...this.#charges.values()]
      .filter((charge) => sameAnchor(charge.scope, filter))
      .filter((charge) => !filter.provider || charge.provider === filter.provider)
      .filter((charge) => !filter.model || charge.model === filter.model)
      .filter((charge) => !filter.from || new Date(charge.recordedAt) >= filter.from)
      .filter((charge) => !filter.to || new Date(charge.recordedAt) < filter.to)
      .map(cloneCharge);
  }

  defaultQuota(scope: Scope, now = new Date()): QuotaSnapshot {
    const charges = [...this.#charges.values()].filter((charge) => userScopeKey(charge.scope) === userScopeKey(scope));
    const period = periodStartFor(now);
    const used = charges
      .filter((charge) => charge.periodStart === period)
      .reduce((total, charge) => total + charge.totalMicroCredits, 0);
    const limit = this.#quotas.get(userScopeKey(scope)) ?? this.defaultMonthlyLimitMicroCredits;
    return {
      scope: {
        tenantId: scope.tenantId,
        botId: scope.botId,
        deploymentId: scope.deploymentId,
        userId: scope.userId,
      },
      periodStart: period,
      monthlyLimitMicroCredits: limit,
      usedMicroCredits: used,
      remainingMicroCredits: Math.max(0, limit - used),
    };
  }
}

function cloneCharge(charge: UsageCharge): UsageCharge {
  return { ...charge, scope: { ...charge.scope }, price: { ...charge.price } };
}
