import { LarkError, type Scope } from "dsh-lark-contracts";

import { calculateCost, validatePrice, validateUsage, withPriceIdentity } from "./pricing.js";
import {
  assertPositiveInteger,
  assertSafeNonNegativeInteger,
  billingUserScope,
  periodStartFor,
  type BillingNamespace,
  type BillingStore,
  type DefaultModelPrice,
  type ModelPrice,
  type QuotaSnapshot,
  type UsageAggregate,
  type UsageAggregateFilter,
  type UsageCharge,
  type UsageInput,
} from "./types.js";

export class BillingQuotaExceededError extends LarkError {
  constructor(readonly quota: QuotaSnapshot) {
    super("BILLING_QUOTA_EXCEEDED", "user-visible", "本月模型额度已用尽");
    this.name = "BillingQuotaExceededError";
  }
}

export interface BillingService {
  assertCanStart(scope: Scope): Promise<void>;
  recordUsage(input: UsageInput): Promise<UsageCharge>;
  quota(scope: Scope, at?: Date): Promise<QuotaSnapshot>;
  setQuota(scope: Scope, monthlyLimitMicroCredits: number): Promise<QuotaSnapshot>;
  listPrices(): Promise<ModelPrice[]>;
  setPrice(price: ModelPrice): Promise<ModelPrice>;
  aggregate(filter: UsageAggregateFilter): Promise<UsageAggregate[]>;
}

export class DefaultBillingService implements BillingService {
  constructor(
    private readonly store: BillingStore,
    private readonly defaultMonthlyLimitMicroCredits: number,
    private readonly defaultPrice: DefaultModelPrice,
    private readonly defaultPrices: readonly ModelPrice[] = [],
    private readonly namespace?: BillingNamespace,
  ) {}

  async assertCanStart(scope: Scope): Promise<void> {
    const snapshot = await this.quota(scope);
    if (snapshot.remainingMicroCredits <= 0) throw new BillingQuotaExceededError(snapshot);
  }

  async recordUsage(input: UsageInput): Promise<UsageCharge> {
    assertPositiveInteger(input.turn + 1, "turn");
    assertPositiveInteger(input.step + 1, "step");
    const usage = validateUsage(input.usage);
    const normalizedInput = { ...input, scope: this.billingScope(input.scope) };
    const existing = await this.store.findCharge(this.chargeKey(normalizedInput));
    if (existing) return existing;
    const configuredPrice = await this.store.getPrice(normalizedInput.provider, normalizedInput.model);
    const price = configuredPrice ?? this.defaultPrices.find((candidate) => candidate.provider === normalizedInput.provider && candidate.model === normalizedInput.model)
      ?? withPriceIdentity(normalizedInput.provider, normalizedInput.model, this.defaultPrice);
    const cost = calculateCost(usage, price);
    const recordedAt = input.recordedAt ?? new Date();
    return this.store.insertCharge({
      id: "",
      scope: normalizedInput.scope,
      runId: normalizedInput.runId,
      turn: normalizedInput.turn,
      step: normalizedInput.step,
      provider: normalizedInput.provider,
      model: normalizedInput.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      ...cost,
      periodStart: periodStartFor(recordedAt),
      price,
      recordedAt: recordedAt.toISOString(),
    });
  }

  async quota(scope: Scope, at = new Date()): Promise<QuotaSnapshot> {
    scope = this.billingScope(scope);
    const userScope = billingUserScope(scope);
    const charges = await this.store.listCharges({ scope, userId: scope.userId, from: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)) });
    const period = periodStartFor(at);
    const used = charges.filter((charge) => charge.periodStart === period).reduce((sum, charge) => sum + charge.totalMicroCredits, 0);
    const configured = await this.store.getQuotaPolicy(userScope);
    const limit = configured ?? this.defaultMonthlyLimitMicroCredits;
    return {
      scope: userScope,
      periodStart: period,
      monthlyLimitMicroCredits: limit,
      usedMicroCredits: assertSafeNonNegativeInteger(used, "used credits"),
      remainingMicroCredits: Math.max(0, limit - used),
    };
  }

  async setQuota(scope: Scope, monthlyLimitMicroCredits: number): Promise<QuotaSnapshot> {
    scope = this.billingScope(scope);
    assertSafeNonNegativeInteger(monthlyLimitMicroCredits, "monthly limit");
    await this.store.setQuotaPolicy(billingUserScope(scope), monthlyLimitMicroCredits);
    return this.quota(scope);
  }

  async listPrices(): Promise<ModelPrice[]> {
    const stored = await this.store.listPrices();
    const overrides = new Map(stored.map((price) => [`${price.provider}\0${price.model}`, price]));
    const defaults = this.defaultPrices.map((price) => overrides.get(`${price.provider}\0${price.model}`) ?? price);
    const known = new Set(defaults.map((price) => `${price.provider}\0${price.model}`));
    return [...defaults, ...stored.filter((price) => !known.has(`${price.provider}\0${price.model}`))];
  }

  async setPrice(price: ModelPrice): Promise<ModelPrice> {
    if (!price.provider.trim() || !price.model.trim()) throw new Error("billing: provider/model 不能为空");
    const normalized = withPriceIdentity(price.provider.trim(), price.model.trim(), validatePrice(price), price.updatedAt || new Date().toISOString());
    return this.store.setPrice(normalized);
  }

  async aggregate(filter: UsageAggregateFilter): Promise<UsageAggregate[]> {
    const charges = await this.store.listCharges({ ...filter, scope: this.billingScope(filter.scope) });
    const groups = new Map<string, UsageAggregate>();
    for (const charge of charges) {
      const key = [charge.periodStart, charge.scope.userId, charge.provider, charge.model].join("\0");
      const current = groups.get(key) ?? {
        periodStart: charge.periodStart,
        tenantId: charge.scope.tenantId,
        botId: charge.scope.botId,
        deploymentId: charge.scope.deploymentId,
        userId: charge.scope.userId,
        provider: charge.provider,
        model: charge.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalMicroCredits: 0,
      };
      current.calls += 1;
      current.inputTokens += charge.inputTokens;
      current.outputTokens += charge.outputTokens;
      current.cacheReadTokens += charge.cacheReadTokens;
      current.cacheWriteTokens += charge.cacheWriteTokens;
      current.reasoningTokens += charge.reasoningTokens;
      current.totalMicroCredits += charge.totalMicroCredits;
      groups.set(key, current);
    }
    return [...groups.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.userId.localeCompare(b.userId) || a.model.localeCompare(b.model));
  }

  private chargeKey(input: UsageInput): string {
    return [input.scope.tenantId, input.scope.botId, input.scope.deploymentId, input.scope.userId, input.scope.conversationId, input.runId, input.turn, input.step, input.provider, input.model].join("\0");
  }

  private billingScope(scope: Scope): Scope {
    return this.namespace ? { ...scope, ...this.namespace } : scope;
  }
}
