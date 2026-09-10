/**
 * 知识存储核心：摄入事务激活 + 混合检索（lark-claw postgres-knowledge-store 平移）。
 *
 * activate 事务顺序不可变（SPEC knowledge.md §6）：锁库行 → 键所有权断言
 * → 同摘要幂等 → 版本 +1 → 插入 processing → 插入 chunks → 旧 active
 * 置 superseded → 新文档置 active。任何一步失败整体回滚，前一激活版本原样。
 */
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import type { Scope } from "dsh-lark-contracts";
import type { KnowledgeVisibility } from "dsh-knowledge";

import { contentDigest } from "./chunker.js";
import type { KnowledgeDatabase, KnowledgeQueryExecutor } from "./database.js";
import { knowledgeBaseId } from "./identifiers.js";
import { SEARCH_KNOWLEDGE_SQL } from "./search-sql.js";

const EMBEDDING_DIMENSIONS = 1_024;

/** 源描述（存储层视角；storageKey = 相对 uploadsRoot 的路径）。 */
export interface SourceDescriptor {
  storageKey: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
}

export interface StoredChunk {
  ordinal: number;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface ActivateInput {
  scope: Scope;
  visibility: KnowledgeVisibility;
  documentKey: string;
  source: SourceDescriptor;
  embeddingModel: string;
  chunks: StoredChunk[];
  metadata?: Record<string, unknown>;
  force?: boolean;
}

export interface SearchInput {
  scope: Scope;
  queryText: string;
  queryEmbedding: number[];
  embeddingModel: string;
  limit: number;
}

export interface StoredKnowledgeResult {
  chunkId: string;
  documentId: string;
  documentKey: string;
  version: number;
  name: string;
  visibility: KnowledgeVisibility;
  ordinal: number;
  text: string;
  vectorScore: number;
  lexicalScore: number;
  fusedScore: number;
}

interface SearchRow extends QueryResultRow {
  chunk_id: string;
  document_id: string;
  document_key: string;
  version: number | string;
  document_title: string;
  visibility: KnowledgeVisibility;
  ordinal: number;
  content: string;
  vector_score: number | string;
  lexical_score: number | string;
  fused_score: number | string;
}

/** 向量字面量：维度与有限值双校验（与 vector(1024) 对齐）。 */
function vectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`Embedding must contain ${EMBEDDING_DIMENSIONS} finite values`);
  }
  return `[${vector.join(",")}]`;
}

function validateActivation(input: ActivateInput): void {
  if (!input.documentKey.trim()) throw new Error("Document key is required");
  if (input.chunks.length === 0) throw new Error("At least one knowledge chunk is required");
  const ordinals = new Set(input.chunks.map((chunk) => chunk.ordinal));
  if (ordinals.size !== input.chunks.length) throw new Error("Chunk ordinals must be unique");
}

export class PostgresKnowledgeStore {
  constructor(private readonly database: KnowledgeDatabase) {}

  /**
   * 事务内激活新版本；返回文档 id。
   * 同源同摘要（force 关闭）且已有 active 版本时幂等返回既有 id。
   */
  async activate(input: ActivateInput): Promise<string> {
    validateActivation(input);
    return this.database.transaction(async (database) => {
      const baseId = await this.upsertBase(database, input);
      await database.query("SELECT id FROM knowledge_bases WHERE id = $1 FOR UPDATE", [baseId]);
      await this.assertDocumentKeyOwnership(database, baseId, input);
      if (!input.force) {
        const existing = await database.query<{ id: string; digests: string[] }>(
          `SELECT d.id, array_agg(c.content_sha256 ORDER BY c.ordinal) digests
           FROM knowledge_documents d JOIN knowledge_chunks c ON c.document_id = d.id
           WHERE d.knowledge_base_id = $1 AND d.document_key = $2
           AND d.source_sha256 = $3 AND d.status = 'active' GROUP BY d.id`,
          [baseId, input.documentKey, input.source.sha256],
        );
        const expected = input.chunks
          .slice().sort((left, right) => left.ordinal - right.ordinal)
          .map((chunk) => contentDigest(chunk.text));
        if (existing.rows[0]?.digests.join("\0") === expected.join("\0")) return existing.rows[0].id;
      }
      const documentId = randomUUID();
      const version = await this.nextVersion(database, baseId, input.documentKey);
      await this.insertDocument(database, baseId, documentId, version, input);
      await this.insertChunks(database, documentId, input);
      await database.query(
        "UPDATE knowledge_documents SET status = 'superseded' WHERE knowledge_base_id = $1 AND document_key = $2 AND status = 'active'",
        [baseId, input.documentKey],
      );
      await database.query(
        "UPDATE knowledge_documents SET status = 'active', activated_at = now() WHERE id = $1",
        [documentId],
      );
      return documentId;
    });
  }

  /** 库行 upsert + ACL 授权（user_private → user 主体；bot_shared → deployment 主体）。 */
  private async upsertBase(database: KnowledgeQueryExecutor, input: ActivateInput): Promise<string> {
    const owner = input.visibility === "user_private" ? input.scope.userId : null;
    const baseId = knowledgeBaseId(input.scope, input.visibility);
    await database.query(
      `INSERT INTO knowledge_bases (id, tenant_id, bot_id, deployment_id, visibility, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET status = 'active'`,
      [baseId, input.scope.tenantId, input.scope.botId, input.scope.deploymentId, input.visibility, owner],
    );
    const principal = input.visibility === "user_private"
      ? ["user", input.scope.userId]
      : ["deployment", input.scope.deploymentId];
    await database.query(
      `INSERT INTO knowledge_acl (knowledge_base_id, principal_type, principal_id, can_read)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (knowledge_base_id, principal_type, principal_id) DO UPDATE SET can_read = true`,
      [baseId, ...principal],
    );
    return baseId;
  }

  /** 文档键所有权断言：历史版本创建者必须全部是当前用户。 */
  private async assertDocumentKeyOwnership(
    database: KnowledgeQueryExecutor,
    baseId: string,
    input: ActivateInput,
  ): Promise<void> {
    const owners = await database.query<{ created_by_user_id: string | null }>(
      `SELECT DISTINCT created_by_user_id FROM knowledge_documents
       WHERE knowledge_base_id=$1 AND document_key=$2`,
      [baseId, input.documentKey],
    );
    if (owners.rows.some((row) => row.created_by_user_id !== input.scope.userId)) {
      throw new Error("Knowledge document key belongs to another user");
    }
  }

  private async nextVersion(database: KnowledgeQueryExecutor, baseId: string, key: string): Promise<number> {
    const result = await database.query<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM knowledge_documents WHERE knowledge_base_id = $1 AND document_key = $2",
      [baseId, key],
    );
    return result.rows[0]!.version;
  }

  private async insertDocument(
    database: KnowledgeQueryExecutor,
    baseId: string,
    documentId: string,
    version: number,
    input: ActivateInput,
  ): Promise<void> {
    await database.query(
      `INSERT INTO knowledge_documents
       (id, knowledge_base_id, document_key, version, source_storage_key, source_name,
        source_mime, source_sha256, source_size, status, metadata, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'processing', $10::jsonb, $11)`,
      [
        documentId, baseId, input.documentKey, version, input.source.storageKey,
        input.source.name, input.source.mime, input.source.sha256, input.source.size,
        JSON.stringify(input.metadata || {}), input.scope.userId,
      ],
    );
  }

  private async insertChunks(
    database: KnowledgeQueryExecutor,
    documentId: string,
    input: ActivateInput,
  ): Promise<void> {
    for (const chunk of input.chunks) {
      await database.query(
        `INSERT INTO knowledge_chunks
         (id, document_id, ordinal, content, content_sha256, embedding_model,
          embedding, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::jsonb)`,
        [
          randomUUID(), documentId, chunk.ordinal, chunk.text, contentDigest(chunk.text),
          input.embeddingModel, vectorLiteral(chunk.embedding),
          JSON.stringify(chunk.metadata || {}),
        ],
      );
    }
  }

  /** 混合检索（ACL 在 SQL 谓词内）。 */
  async search(input: SearchInput): Promise<StoredKnowledgeResult[]> {
    if (!input.queryText.trim()) throw new Error("Knowledge query is required");
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("Search limit must be positive");
    const result = await this.database.query<SearchRow>(SEARCH_KNOWLEDGE_SQL, [
      input.scope.tenantId,
      input.scope.botId,
      input.scope.deploymentId,
      input.scope.userId,
      input.embeddingModel,
      vectorLiteral(input.queryEmbedding),
      input.queryText,
      input.limit,
    ]);
    return result.rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      documentKey: row.document_key,
      version: Number(row.version),
      name: row.document_title,
      visibility: row.visibility,
      ordinal: row.ordinal,
      text: row.content,
      vectorScore: Number(row.vector_score),
      lexicalScore: Number(row.lexical_score),
      fusedScore: Number(row.fused_score),
    }));
  }
}
