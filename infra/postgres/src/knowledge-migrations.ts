import { runMigrations, type MigrationDatabase } from "./migration.js";

/**
 * 知识库迁移清单。
 *
 * 迁移由 PostgreSQL runtime 持有，避免 supervisor 依赖已迁移/已删除的
 * lark-claw skills/rag 文件路径。知识 Provider 复用同一清单并负责 checksum。
 */

export const KNOWLEDGE_MIGRATION_001 = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_bases (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('user_private', 'bot_shared')),
  owner_user_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (visibility = 'user_private' AND owner_user_id IS NOT NULL)
    OR (visibility = 'bot_shared' AND owner_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_bases_scope_key
  ON knowledge_bases (
    tenant_id,
    bot_id,
    deployment_id,
    visibility,
    COALESCE(owner_user_id, '')
  );

CREATE TABLE IF NOT EXISTS knowledge_acl (
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'deployment')),
  principal_id text NOT NULL,
  can_read boolean NOT NULL DEFAULT true,
  PRIMARY KEY (knowledge_base_id, principal_type, principal_id)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id uuid PRIMARY KEY,
  knowledge_base_id uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
  document_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source_storage_key text NOT NULL,
  source_name text NOT NULL,
  source_mime text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_size bigint NOT NULL CHECK (source_size >= 0),
  status text NOT NULL CHECK (status IN ('processing', 'active', 'superseded', 'failed', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  UNIQUE (knowledge_base_id, document_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_one_active
  ON knowledge_documents (knowledge_base_id, document_key)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL CHECK (length(content) > 0),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  embedding_model text NOT NULL,
  embedding vector(1024) NOT NULL,
  visual_embedding vector(1024),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_lexical_idx
  ON knowledge_chunks USING gin (content_tsv);

CREATE INDEX IF NOT EXISTS knowledge_chunks_vector_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS knowledge_chunks_visual_vector_idx
  ON knowledge_chunks USING hnsw (visual_embedding vector_cosine_ops);
`;

export const KNOWLEDGE_MIGRATION_002 = `
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS created_by_user_id text;

UPDATE knowledge_documents d
SET created_by_user_id = COALESCE(
  d.metadata #>> '{sourceAttachment,scope,userId}',
  b.owner_user_id
)
FROM knowledge_bases b
WHERE d.knowledge_base_id = b.id
  AND d.created_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS knowledge_documents_creator_idx
  ON knowledge_documents (knowledge_base_id, created_by_user_id);
`;

export const KNOWLEDGE_MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS knowledge_ingestion_jobs (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  bot_id text NOT NULL,
  deployment_id text NOT NULL,
  user_id text NOT NULL,
  conversation_id text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  source_size bigint NOT NULL CHECK (source_size >= 0),
  visibility text NOT NULL CHECK (visibility IN ('user_private', 'bot_shared')),
  category text NOT NULL CHECK (category IN (
    'general', 'product_manual', 'technical_spec',
    'project_document', 'policy_process', 'faq'
  )),
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  stage text NOT NULL CHECK (stage IN (
    'queued', 'inspecting', 'extracting', 'chunking',
    'embedding', 'indexing', 'completed', 'failed'
  )),
  progress integer NOT NULL CHECK (progress BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  document_id uuid REFERENCES knowledge_documents(id) ON DELETE SET NULL,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS knowledge_ingestion_jobs_scope_idx
  ON knowledge_ingestion_jobs (
    tenant_id, bot_id, deployment_id, user_id, conversation_id, created_at DESC
  );
`;

/** 迁移顺序不可变；checksum 由 knowledge Provider 的 runMigrations 固化。 */
export const KNOWLEDGE_MIGRATIONS = [
  { version: "knowledge/001_knowledge", sql: KNOWLEDGE_MIGRATION_001 },
  { version: "knowledge/002_document_creator", sql: KNOWLEDGE_MIGRATION_002 },
  { version: "knowledge/003_ingestion_jobs", sql: KNOWLEDGE_MIGRATION_003 },
] as const;

/** supervisor 与 Provider 共享同一锁和 checksum 路径。 */
export async function runKnowledgeMigrations(database: MigrationDatabase): Promise<void> {
  await runMigrations(database, KNOWLEDGE_MIGRATIONS);
}
