import type { Migration } from "dsh-lark-postgres-runtime";

export const MEMORY_MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS memory_cubes (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  owner_user_id text NOT NULL,
  cube_key text NOT NULL,
  name text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN (
    'user_private', 'project_shared', 'agent_shared',
    'deployment_shared', 'tenant_shared'
  )),
  project_key text,
  agent_key text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, bot_id, deployment_id, cube_key)
);

CREATE TABLE IF NOT EXISTS memory_cube_members (
  cube_id uuid NOT NULL REFERENCES memory_cubes(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cube_id, user_id)
);

CREATE TABLE IF NOT EXISTS memory_nodes (
  id uuid PRIMARY KEY,
  cube_id uuid NOT NULL REFERENCES memory_cubes(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  author_user_id text NOT NULL,
  kind text NOT NULL,
  modality text NOT NULL CHECK (modality IN ('text', 'image', 'tool_trace', 'persona')),
  parts jsonb NOT NULL,
  searchable_text text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  mem0_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_nodes_scope_idx
  ON memory_nodes (tenant_id, bot_id, deployment_id, cube_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS memory_nodes_text_idx
  ON memory_nodes USING gin (to_tsvector('simple'::regconfig, searchable_text));
CREATE INDEX IF NOT EXISTS memory_nodes_mem0_idx ON memory_nodes (mem0_id) WHERE mem0_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_edges (
  id uuid PRIMARY KEY,
  cube_id uuid NOT NULL REFERENCES memory_cubes(id) ON DELETE CASCADE,
  from_node_id uuid NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  to_node_id uuid NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts', 'derived_from', 'related_to', 'part_of')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_node_id, to_node_id, relation)
);
CREATE INDEX IF NOT EXISTS memory_edges_node_idx ON memory_edges (from_node_id, to_node_id);

CREATE TABLE IF NOT EXISTS memory_write_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  user_id text NOT NULL,
  conversation_id text NOT NULL,
  command jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_write_jobs_due_idx
  ON memory_write_jobs (status, available_at, created_at);
`;

export const MEMORY_MIGRATION_002 = `
ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS source jsonb;
ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS mem0_id text;
CREATE INDEX IF NOT EXISTS memory_nodes_mem0_idx ON memory_nodes (mem0_id) WHERE mem0_id IS NOT NULL;
`;

export const MEMORY_MIGRATIONS: readonly Migration[] = [
  { version: "memory/001_graph_scheduler", sql: MEMORY_MIGRATION_001 },
  { version: "memory/002_node_index", sql: MEMORY_MIGRATION_002 },
];
