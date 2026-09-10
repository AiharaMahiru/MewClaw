import type { Migration } from "dsh-lark-postgres-runtime";

export const AUTH_IMPORT_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS auth_import_approvals (
  approval_hash text PRIMARY KEY CHECK (approval_hash ~ '^[a-f0-9]{64}$'),
  operator_user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  plan_id text NOT NULL,
  source_system text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_import_approvals_expiry_idx
  ON auth_import_approvals (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_import_mappings (
  source_system text NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL,
  plan_id text NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('user', 'session', 'workspace')),
  target_id text,
  target_user_id uuid,
  result text NOT NULL CHECK (result IN (
    'migrated', 'merged', 'rejected', 'reset_required', 'claimed', 'unchanged'
  )),
  reason_code text,
  created_target boolean NOT NULL,
  created_at timestamptz NOT NULL,
  rolled_back_at timestamptz,
  PRIMARY KEY (source_system, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS auth_import_mappings_run_idx
  ON auth_import_mappings (run_id, plan_id, source_system, created_at);
`;

export const AUTH_IMPORT_MIGRATION_002 = `
ALTER TABLE auth_import_approvals
  ADD COLUMN IF NOT EXISTS operator_session_id uuid REFERENCES auth_sessions(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS scope_digest text CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS operation text CHECK (operation IN ('apply-user', 'claim-resource', 'rollback-run')),
  ADD COLUMN IF NOT EXISTS payload_digest text CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS snapshot_digest text CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS cutover_epoch_id text;
`;

export const AUTH_IMPORT_MIGRATION_003 = `
ALTER TABLE auth_import_approvals
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz;

ALTER TABLE auth_import_approvals
  DROP CONSTRAINT IF EXISTS auth_import_approvals_operation_check;
ALTER TABLE auth_import_approvals
  ADD CONSTRAINT auth_import_approvals_operation_check
  CHECK (operation IN ('apply-run', 'apply-user', 'claim-resource', 'rollback-run'));
`;

export const AUTH_IMPORT_MIGRATION_004 = `
CREATE TABLE IF NOT EXISTS auth_import_runs (
  run_id text PRIMARY KEY,
  plan_id text NOT NULL,
  source_system text NOT NULL,
  manifest_source_id text NOT NULL,
  manifest_source_digest text NOT NULL CHECK (manifest_source_digest ~ '^[a-f0-9]{64}$'),
  snapshot_digest text NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  plan_digest text NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  cutover_epoch_id text NOT NULL,
  scope_digest text NOT NULL CHECK (scope_digest ~ '^[a-f0-9]{64}$'),
  operator_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_import_actions (
  run_id text NOT NULL REFERENCES auth_import_runs(run_id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (action_id ~ '^[a-f0-9]{64}$'),
  sequence integer NOT NULL CHECK (sequence >= 1),
  operation text NOT NULL CHECK (operation IN ('apply-user', 'claim-resource')),
  source_system text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('user', 'session', 'workspace')),
  source_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'completed')),
  lease_token_hash text CHECK (lease_token_hash ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  result_json jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, action_id),
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, source_system, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS auth_import_actions_lease_idx
  ON auth_import_actions (run_id, status, lease_expires_at, sequence);

CREATE TABLE IF NOT EXISTS auth_import_outbox (
  event_id uuid PRIMARY KEY,
  run_id text NOT NULL,
  action_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  lease_token_hash text CHECK (lease_token_hash ~ '^[a-f0-9]{64}$'),
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  acked_at timestamptz,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (run_id, action_id) REFERENCES auth_import_actions(run_id, action_id) ON DELETE RESTRICT,
  UNIQUE (run_id, action_id),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS auth_import_outbox_delivery_idx
  ON auth_import_outbox (run_id, acked_at, lease_expires_at, sequence);
`;

export const AUTH_IMPORT_MIGRATION_005 = `
ALTER TABLE auth_import_runs
  ADD COLUMN IF NOT EXISTS actions_digest text;
UPDATE auth_import_runs
  SET actions_digest = repeat('0', 64)
  WHERE actions_digest IS NULL;
ALTER TABLE auth_import_runs
  ALTER COLUMN actions_digest SET NOT NULL;
ALTER TABLE auth_import_runs
  DROP CONSTRAINT IF EXISTS auth_import_runs_actions_digest_check;
ALTER TABLE auth_import_runs
  ADD CONSTRAINT auth_import_runs_actions_digest_check
  CHECK (actions_digest ~ '^[a-f0-9]{64}$');
`;

export const AUTH_IMPORT_MIGRATION_006 = `
ALTER TABLE auth_import_approvals
  DROP CONSTRAINT IF EXISTS auth_import_approvals_operation_check;
ALTER TABLE auth_import_approvals
  ADD CONSTRAINT auth_import_approvals_operation_check
  CHECK (operation IN (
    'apply-run', 'apply-user', 'claim-resource', 'rollback-run', 'sync-credential'
  ));
`;

export const AUTH_IMPORT_MIGRATIONS: readonly Migration[] = [
  { version: "auth/004_import_provisioning", sql: AUTH_IMPORT_MIGRATION_001 },
  { version: "auth/005_import_approval_binding", sql: AUTH_IMPORT_MIGRATION_002 },
  { version: "auth/006_import_approval_consumption", sql: AUTH_IMPORT_MIGRATION_003 },
  { version: "auth/007_import_action_outbox", sql: AUTH_IMPORT_MIGRATION_004 },
  { version: "auth/008_import_action_manifest_binding", sql: AUTH_IMPORT_MIGRATION_005 },
  { version: "auth/009_import_credential_sync_approval", sql: AUTH_IMPORT_MIGRATION_006 },
];
