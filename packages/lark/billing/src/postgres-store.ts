import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import type { Scope } from "dsh-lark-contracts";

import type { BillingDatabase } from "./database.js";
import type {
  BillingStore,
  BillingUserScope,
  ModelPrice,
  UsageAggregateFilter,
  UsageCharge,
} from "./types.js";
import { usageKey } from "./types.js";

interface PriceRow extends QueryResultRow {
  provider: string;
  model: string;
  input_micro_credits_per_million: string | number;
  output_micro_credits_per_million: string | number;
  cache_read_micro_credits_per_million: string | number;
  cache_write_micro_credits_per_million: string | number;
  reasoning_micro_credits_per_million: string | number;
  updated_at: Date | string;
}

interface ChargeRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  bot_id: string;
  deployment_id: string;
  user_id: string;
  conversation_id: string;
  run_id: string;
  turn: number;
  step: number;
  provider: string;
  model: string;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  reasoning_tokens: string | number;
  input_micro_credits: string | number;
  output_micro_credits: string | number;
  cache_read_micro_credits: string | number;
  cache_write_micro_credits: string | number;
  reasoning_micro_credits: string | number;
  total_micro_credits: string | number;
  period_start: Date | string;
  price: ModelPrice;
  recorded_at: Date | string;
}

const CHARGE_COLUMNS = "id, tenant_id, bot_id, deployment_id, user_id, conversation_id, run_id, turn, step, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, input_micro_credits, output_micro_credits, cache_read_micro_credits, cache_write_micro_credits, reasoning_micro_credits, total_micro_credits, period_start, price, recorded_at";

function integer(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("billing: PostgreSQL returned an invalid integer");
  return parsed;
}

function scopeValues(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId, scope.conversationId];
}

function priceFromRow(row: PriceRow): ModelPrice {
  return {
    provider: row.provider,
    model: row.model,
    inputMicroCreditsPerMillion: integer(row.input_micro_credits_per_million),
    outputMicroCreditsPerMillion: integer(row.output_micro_credits_per_million),
    cacheReadMicroCreditsPerMillion: integer(row.cache_read_micro_credits_per_million),
    cacheWriteMicroCreditsPerMillion: integer(row.cache_write_micro_credits_per_million),
    reasoningMicroCreditsPerMillion: integer(row.reasoning_micro_credits_per_million),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function chargeFromRow(row: ChargeRow): UsageCharge {
  return {
    id: row.id,
    scope: {
      tenantId: row.tenant_id as Scope["tenantId"],
      botId: row.bot_id as Scope["botId"],
      deploymentId: row.deployment_id as Scope["deploymentId"],
      userId: row.user_id as Scope["userId"],
      conversationId: row.conversation_id as Scope["conversationId"],
    },
    runId: row.run_id,
    turn: row.turn,
    step: row.step,
    provider: row.provider,
    model: row.model,
    inputTokens: integer(row.input_tokens),
    outputTokens: integer(row.output_tokens),
    cacheReadTokens: integer(row.cache_read_tokens),
    cacheWriteTokens: integer(row.cache_write_tokens),
    reasoningTokens: integer(row.reasoning_tokens),
    inputMicroCredits: integer(row.input_micro_credits),
    outputMicroCredits: integer(row.output_micro_credits),
    cacheReadMicroCredits: integer(row.cache_read_micro_credits),
    cacheWriteMicroCredits: integer(row.cache_write_micro_credits),
    reasoningMicroCredits: integer(row.reasoning_micro_credits),
    totalMicroCredits: integer(row.total_micro_credits),
    periodStart: String(row.period_start).slice(0, 10),
    price: row.price,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export class PostgresBillingStore implements BillingStore {
  constructor(private readonly database: BillingDatabase) {}

  async getPrice(provider: string, model: string): Promise<ModelPrice | undefined> {
    const result = await this.database.query<PriceRow>("SELECT * FROM billing_model_prices WHERE provider = $1 AND model = $2", [provider, model]);
    return result.rows[0] ? priceFromRow(result.rows[0]) : undefined;
  }

  async listPrices(): Promise<ModelPrice[]> {
    const result = await this.database.query<PriceRow>("SELECT * FROM billing_model_prices ORDER BY provider, model");
    return result.rows.map(priceFromRow);
  }

  async setPrice(price: ModelPrice): Promise<ModelPrice> {
    const result = await this.database.query<PriceRow>(
      `INSERT INTO billing_model_prices (provider, model, input_micro_credits_per_million, output_micro_credits_per_million, cache_read_micro_credits_per_million, cache_write_micro_credits_per_million, reasoning_micro_credits_per_million, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (provider, model) DO UPDATE SET input_micro_credits_per_million = EXCLUDED.input_micro_credits_per_million, output_micro_credits_per_million = EXCLUDED.output_micro_credits_per_million, cache_read_micro_credits_per_million = EXCLUDED.cache_read_micro_credits_per_million, cache_write_micro_credits_per_million = EXCLUDED.cache_write_micro_credits_per_million, reasoning_micro_credits_per_million = EXCLUDED.reasoning_micro_credits_per_million, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [price.provider, price.model, price.inputMicroCreditsPerMillion, price.outputMicroCreditsPerMillion, price.cacheReadMicroCreditsPerMillion, price.cacheWriteMicroCreditsPerMillion, price.reasoningMicroCreditsPerMillion, price.updatedAt],
    );
    return priceFromRow(result.rows[0]!);
  }

  async getQuotaPolicy(scope: BillingUserScope): Promise<number | undefined> {
    const result = await this.database.query<{ monthly_limit_micro_credits: string | number }>(
      "SELECT monthly_limit_micro_credits FROM billing_quotas WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND user_id = $4",
      [scope.tenantId, scope.botId, scope.deploymentId, scope.userId],
    );
    return result.rows[0] ? integer(result.rows[0].monthly_limit_micro_credits) : undefined;
  }

  async setQuotaPolicy(scope: BillingUserScope, limit: number): Promise<void> {
    await this.database.query(
      `INSERT INTO billing_quotas (tenant_id, bot_id, deployment_id, user_id, monthly_limit_micro_credits, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (tenant_id, bot_id, deployment_id, user_id) DO UPDATE SET monthly_limit_micro_credits = EXCLUDED.monthly_limit_micro_credits, updated_at = EXCLUDED.updated_at`,
      [scope.tenantId, scope.botId, scope.deploymentId, scope.userId, limit],
    );
  }

  async findCharge(key: string): Promise<UsageCharge | undefined> {
    const parts = key.split("\0");
    if (parts.length !== 10) return undefined;
    const result = await this.database.query<ChargeRow>(
      `SELECT ${CHARGE_COLUMNS} FROM billing_usage_ledger
       WHERE tenant_id = $1 AND bot_id = $2 AND deployment_id = $3 AND user_id = $4 AND conversation_id = $5
         AND run_id = $6 AND turn = $7 AND step = $8 AND provider = $9 AND model = $10`,
      [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], Number(parts[6]), Number(parts[7]), parts[8], parts[9]],
    );
    return result.rows[0] ? chargeFromRow(result.rows[0]) : undefined;
  }

  async insertCharge(charge: UsageCharge): Promise<UsageCharge> {
    const result = await this.database.query<ChargeRow>(
      `INSERT INTO billing_usage_ledger (${CHARGE_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (tenant_id, bot_id, deployment_id, user_id, conversation_id, run_id, turn, step, provider, model) DO NOTHING
       RETURNING ${CHARGE_COLUMNS}`,
      [charge.id || randomUUID(), ...scopeValues(charge.scope), charge.runId, charge.turn, charge.step, charge.provider, charge.model,
        charge.inputTokens, charge.outputTokens, charge.cacheReadTokens, charge.cacheWriteTokens, charge.reasoningTokens,
        charge.inputMicroCredits, charge.outputMicroCredits, charge.cacheReadMicroCredits, charge.cacheWriteMicroCredits,
        charge.reasoningMicroCredits, charge.totalMicroCredits, charge.periodStart, JSON.stringify(charge.price), charge.recordedAt],
    );
    if (result.rows[0]) return chargeFromRow(result.rows[0]);
    const existing = await this.findCharge(usageKey(charge));
    if (!existing) throw new Error("billing: idempotent ledger row disappeared");
    return existing;
  }

  async listCharges(filter: UsageAggregateFilter): Promise<UsageCharge[]> {
    const clauses = ["tenant_id = $1", "bot_id = $2", "deployment_id = $3"];
    const params: unknown[] = [filter.scope.tenantId, filter.scope.botId, filter.scope.deploymentId];
    if (filter.userId) { params.push(filter.userId); clauses.push(`user_id = $${params.length}`); }
    if (filter.provider) { params.push(filter.provider); clauses.push(`provider = $${params.length}`); }
    if (filter.model) { params.push(filter.model); clauses.push(`model = $${params.length}`); }
    if (filter.from) { params.push(filter.from); clauses.push(`recorded_at >= $${params.length}`); }
    if (filter.to) { params.push(filter.to); clauses.push(`recorded_at < $${params.length}`); }
    const result = await this.database.query<ChargeRow>(`SELECT ${CHARGE_COLUMNS} FROM billing_usage_ledger WHERE ${clauses.join(" AND ")} ORDER BY recorded_at`, params);
    return result.rows.map(chargeFromRow);
  }
}
