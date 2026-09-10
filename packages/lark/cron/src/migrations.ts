/**
 * 跨会话 cron 迁移（lark-claw skills/cron/migrations/001_cron.sql 平移，逐字保留）。
 */
export const CRON_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS cron_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  user_id text NOT NULL,
  conversation_id text NOT NULL,
  task text NOT NULL,
  schedule_kind text NOT NULL CHECK (schedule_kind IN ('at', 'cron')),
  schedule_value text NOT NULL,
  timezone text,
  end_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  lease_token text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS cron_jobs_due_idx
  ON cron_jobs (next_run_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS cron_jobs_scope_idx
  ON cron_jobs (tenant_id, bot_id, deployment_id, user_id, conversation_id, created_at);

CREATE INDEX IF NOT EXISTS cron_jobs_user_management_idx
  ON cron_jobs (tenant_id, bot_id, deployment_id, user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS cron_jobs_user_status_management_idx
  ON cron_jobs (tenant_id, bot_id, deployment_id, user_id, status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS cron_runs (
  run_id text PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  output text NOT NULL,
  error text,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_token text,
  delivery_lease_until timestamptz,
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS cron_runs_delivery_idx
  ON cron_runs (finished_at)
  WHERE delivered_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cron_runs_job_scheduled_idx
  ON cron_runs (job_id, scheduled_for);
`;

/** 迁移清单（版本键加 cron/ 前缀与既有迁移隔离）。 */
export const CRON_MIGRATIONS = [
  { version: "cron/001_cron", sql: CRON_MIGRATION_001 },
] as const;
