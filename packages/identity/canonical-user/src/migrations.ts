export const CANONICAL_USER_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS canonical_user_principals (
  principal_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('web', 'feishu-provisional')),
  canonical_user_id uuid,
  created_at timestamptz NOT NULL,
  claimed_at timestamptz,
  CHECK ((kind = 'web' AND canonical_user_id IS NOT NULL) OR kind = 'feishu-provisional')
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_user_principals_web_idx
  ON canonical_user_principals (tenant_id, bot_id, deployment_id, canonical_user_id)
  WHERE kind = 'web';

CREATE TABLE IF NOT EXISTS canonical_user_bindings (
  binding_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  provider text NOT NULL CHECK (provider = 'feishu'),
  subject text NOT NULL,
  principal_id uuid NOT NULL REFERENCES canonical_user_principals(principal_id),
  canonical_user_id uuid,
  version bigint NOT NULL CHECK (version >= 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  event_id uuid NOT NULL UNIQUE,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  UNIQUE (tenant_id, bot_id, deployment_id, provider, subject, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_user_bindings_active_idx
  ON canonical_user_bindings (tenant_id, bot_id, deployment_id, provider, subject)
  WHERE valid_to IS NULL;

CREATE TABLE IF NOT EXISTS canonical_user_outbox (
  sequence bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('identity-provisioned', 'identity-bound', 'identity-unbound')),
  outcome text NOT NULL CHECK (outcome IN ('created', 'bound', 'unbound', 'unchanged')),
  command_digest text NOT NULL CHECK (length(command_digest) = 64),
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  binding_id uuid NOT NULL,
  principal_id uuid NOT NULL REFERENCES canonical_user_principals(principal_id),
  canonical_user_id uuid,
  binding_version bigint NOT NULL CHECK (binding_version >= 1),
  subject_digest text NOT NULL CHECK (length(subject_digest) = 64),
  occurred_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS canonical_user_outbox_delivery_idx
  ON canonical_user_outbox (delivered_at, lease_expires_at, sequence);
`;

export const CANONICAL_USER_MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS canonical_user_commands (
  event_id uuid PRIMARY KEY,
  command_digest text NOT NULL CHECK (length(command_digest) = 64),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  completed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS canonical_user_principals_members_idx
  ON canonical_user_principals (tenant_id, bot_id, deployment_id, canonical_user_id, created_at, principal_id)
  WHERE canonical_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION canonical_user_enforce_claim_write_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.canonical_user_id IS NOT NULL
     AND NEW.canonical_user_id IS DISTINCT FROM OLD.canonical_user_id THEN
    RAISE EXCEPTION 'canonical-user: principal claim is write-once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canonical_user_principal_claim_write_once ON canonical_user_principals;
CREATE TRIGGER canonical_user_principal_claim_write_once
  BEFORE UPDATE OF canonical_user_id ON canonical_user_principals
  FOR EACH ROW EXECUTE FUNCTION canonical_user_enforce_claim_write_once();
`;

export const CANONICAL_USER_MIGRATIONS = [
  { version: "canonical-user/001_principals_bindings_outbox", sql: CANONICAL_USER_MIGRATION_001 },
  { version: "canonical-user/002_command_journal_members_index", sql: CANONICAL_USER_MIGRATION_002 },
] as const;
