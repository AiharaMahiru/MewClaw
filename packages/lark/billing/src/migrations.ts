export const BILLING_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS billing_model_prices (
  provider text NOT NULL,
  model text NOT NULL,
  input_micro_credits_per_million bigint NOT NULL CHECK (input_micro_credits_per_million >= 0),
  output_micro_credits_per_million bigint NOT NULL CHECK (output_micro_credits_per_million >= 0),
  cache_read_micro_credits_per_million bigint NOT NULL CHECK (cache_read_micro_credits_per_million >= 0),
  cache_write_micro_credits_per_million bigint NOT NULL CHECK (cache_write_micro_credits_per_million >= 0),
  reasoning_micro_credits_per_million bigint NOT NULL CHECK (reasoning_micro_credits_per_million >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS billing_quotas (
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  user_id text NOT NULL,
  monthly_limit_micro_credits bigint NOT NULL CHECK (monthly_limit_micro_credits >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, bot_id, deployment_id, user_id)
);

CREATE TABLE IF NOT EXISTS billing_usage_ledger (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  user_id text NOT NULL,
  conversation_id text NOT NULL,
  run_id text NOT NULL,
  turn integer NOT NULL CHECK (turn >= 0),
  step integer NOT NULL CHECK (step >= 0),
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL CHECK (cache_write_tokens >= 0),
  reasoning_tokens bigint NOT NULL CHECK (reasoning_tokens >= 0),
  input_micro_credits bigint NOT NULL CHECK (input_micro_credits >= 0),
  output_micro_credits bigint NOT NULL CHECK (output_micro_credits >= 0),
  cache_read_micro_credits bigint NOT NULL CHECK (cache_read_micro_credits >= 0),
  cache_write_micro_credits bigint NOT NULL CHECK (cache_write_micro_credits >= 0),
  reasoning_micro_credits bigint NOT NULL CHECK (reasoning_micro_credits >= 0),
  total_micro_credits bigint NOT NULL CHECK (total_micro_credits >= 0),
  period_start date NOT NULL,
  price jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (tenant_id, bot_id, deployment_id, user_id, conversation_id, run_id, turn, step, provider, model)
);

CREATE INDEX IF NOT EXISTS billing_usage_scope_period_idx
  ON billing_usage_ledger (tenant_id, bot_id, deployment_id, user_id, period_start);
CREATE INDEX IF NOT EXISTS billing_usage_model_period_idx
  ON billing_usage_ledger (provider, model, period_start);
`;

export const BILLING_MIGRATIONS = [
  { version: "billing/001_billing", sql: BILLING_MIGRATION_001 },
] as const;
