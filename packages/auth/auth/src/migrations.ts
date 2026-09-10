import type { Migration } from "dsh-lark-postgres-runtime";

export const AUTH_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS auth_users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  default_mode text NOT NULL CHECK (default_mode IN ('full', 'lightweight')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_password_credentials (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  encoded text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_hash text,
  user_agent_hash text
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON auth_sessions (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_email_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify-email', 'reset-password')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid REFERENCES auth_users(id) ON DELETE CASCADE,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS auth_identities (
  provider text NOT NULL CHECK (provider = 'feishu'),
  subject text NOT NULL,
  union_id text,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_identities_union_idx
  ON auth_identities (provider, union_id) WHERE union_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_resources (
  resource_type text NOT NULL CHECK (resource_type IN ('session', 'workspace')),
  resource_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  resource_path text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS auth_resources_user_idx ON auth_resources (user_id, resource_type, created_at);

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  request_id text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_audit_time_idx ON auth_audit_log (created_at DESC);
`;

export const AUTH_MIGRATION_002 = `
CREATE TABLE IF NOT EXISTS auth_feishu_pairing_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  open_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_feishu_pairing_expiry_idx ON auth_feishu_pairing_tokens (expires_at) WHERE consumed_at IS NULL;
`;

export const AUTH_MIGRATION_003 = `
ALTER TABLE auth_feishu_pairing_tokens ADD COLUMN IF NOT EXISTS session_id text;
`;

/** 用户私有模型配置：所有权与默认引用均由数据库约束，密钥仅存 AEAD 密文。 */
export const AUTH_MIGRATION_004 = `
CREATE TABLE IF NOT EXISTS auth_user_model_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  base_url text NOT NULL,
  model_ids jsonb NOT NULL CHECK (jsonb_typeof(model_ids) = 'array'),
  default_model text NOT NULL,
  key_version smallint NOT NULL CHECK (key_version > 0),
  api_key_iv text NOT NULL,
  api_key_tag text NOT NULL,
  api_key_ciphertext text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS auth_user_model_profiles_owner_idx
  ON auth_user_model_profiles (user_id, updated_at DESC, id);

CREATE TABLE IF NOT EXISTS auth_user_model_defaults (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (user_id, profile_id)
    REFERENCES auth_user_model_profiles(user_id, id) ON DELETE CASCADE
);
`;

export const AUTH_MIGRATIONS: readonly Migration[] = [
  { version: "auth/001_users_sessions", sql: AUTH_MIGRATION_001 },
  { version: "auth/002_feishu_pairing", sql: AUTH_MIGRATION_002 },
  { version: "auth/003_pairing_session", sql: AUTH_MIGRATION_003 },
  { version: "auth/004_user_model_profiles", sql: AUTH_MIGRATION_004 },
];
