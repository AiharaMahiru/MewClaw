/**
 * 管理面数据服务（lark-claw knowledge-admin-service 平移）。
 *
 * 安全不变式：读谓词 VISIBLE（ACL 查询内）；写谓词 MANAGEABLE 额外要求
 * created_by_user_id = scope.user 且行锁 FOR UPDATE；谓词无匹配行返回
 * undefined（不泄露存在性）。
 */
import type { QueryResultRow } from "pg";

import type { Scope } from "dsh-lark-contracts";
import type {
  DocumentId,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeSnapshot,
  KnowledgeVisibility,
} from "dsh-knowledge";

import type { KnowledgeDatabase, KnowledgeQueryExecutor } from "./database.js";
import { knowledgeBaseId } from "./identifiers.js";

export interface ReindexSource {
  scope: Scope;
  sourcePath: string;
  name: string;
  mime: string;
  visibility: KnowledgeVisibility;
  documentKey: string;
  category: KnowledgeCategory;
  tags: string[];
}

interface DocumentRow extends QueryResultRow {
  id: string;
  base_id: string;
  document_key: string;
  source_name: string;
  source_storage_key: string;
  source_mime: string;
  source_size: number | string;
  source_sha256: string;
  visibility: KnowledgeVisibility;
  status: KnowledgeDocument["status"];
  version: number | string;
  chunk_count: number | string;
  metadata: Record<string, unknown> | string;
  created_at: Date | string;
  activated_at: Date | string | null;
  created_by_user_id: string | null;
}

interface SummaryRow extends QueryResultRow {
  total_versions: number | string;
  active_documents: number | string;
  private_documents: number | string;
  shared_documents: number | string;
  archived_documents: number | string;
  total_chunks: number | string;
  total_bytes: number | string;
}

const CATEGORIES: readonly KnowledgeCategory[] = [
  "general", "product_manual", "technical_spec", "project_document", "policy_process", "faq",
];

function scopeValues(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId];
}

function metadataOf(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

function categoryOf(details: Record<string, unknown>): KnowledgeCategory {
  return CATEGORIES.includes(details.category as KnowledgeCategory) ? details.category as KnowledgeCategory : "general";
}

function tagsOf(details: Record<string, unknown>): string[] {
  const tags = details.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === "string").slice(0, 8);
}

/** 行 → 契约视图（canManage = 当前用户是创建者）。 */
function mapDocument(row: DocumentRow, userId: string): KnowledgeDocument {
  const details = metadataOf(row.metadata);
  return {
    docId: row.id as DocumentId,
    baseId: row.base_id,
    documentKey: row.document_key,
    name: row.source_name,
    mimeType: row.source_mime,
    size: Number(row.source_size),
    sha256: row.source_sha256,
    visibility: row.visibility,
    status: row.status,
    version: Number(row.version),
    chunkCount: Number(row.chunk_count),
    category: categoryOf(details),
    tags: tagsOf(details),
    createdAt: new Date(row.created_at).toISOString(),
    activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    canManage: row.created_by_user_id === userId
      && ["active", "deleted", "failed"].includes(row.status),
  };
}

/** 可见性谓词（读面）：与检索 SQL 同一 ACL 语义。 */
const VISIBLE_SCOPE_SQL = `
  b.tenant_id=$1 AND b.bot_id=$2 AND b.deployment_id=$3
    AND ((b.visibility='user_private' AND b.owner_user_id=$4)
      OR (b.visibility='bot_shared' AND EXISTS (
        SELECT 1 FROM knowledge_acl acl WHERE acl.knowledge_base_id=b.id AND acl.can_read=true
        AND ((acl.principal_type='deployment' AND acl.principal_id=$3)
          OR (acl.principal_type='user' AND acl.principal_id=$4)))))`;

/** 管理谓词（写面）：在可见性之上追加创建者 = 当前用户。 */
const MANAGEABLE_DOCUMENT_SQL = `
  d.created_by_user_id=$5 AND ((b.visibility='user_private' AND b.owner_user_id=$5)
    OR (b.visibility='bot_shared' AND EXISTS (
      SELECT 1 FROM knowledge_acl acl WHERE acl.knowledge_base_id=b.id AND acl.can_read=true
      AND ((acl.principal_type='deployment' AND acl.principal_id=$4)
        OR (acl.principal_type='user' AND acl.principal_id=$5)))))`;

const VISIBLE_DOCUMENTS_SQL = `
  SELECT d.id,b.id base_id,d.document_key,d.source_storage_key,d.source_name,d.source_mime,d.source_size,
    d.source_sha256,b.visibility,d.status,d.version,d.metadata,d.created_at,d.activated_at,
    d.created_by_user_id,
    count(c.id)::int chunk_count
  FROM knowledge_documents d JOIN knowledge_bases b ON b.id=d.knowledge_base_id
  LEFT JOIN knowledge_chunks c ON c.document_id=d.id
  WHERE ${VISIBLE_SCOPE_SQL}`;

const VISIBLE_SUMMARY_SQL = `
  SELECT count(*) total_versions,
    count(*) FILTER (WHERE status='active') active_documents,
    count(*) FILTER (WHERE status='active' AND visibility='user_private') private_documents,
    count(*) FILTER (WHERE status='active' AND visibility='bot_shared') shared_documents,
    count(*) FILTER (WHERE status='deleted') archived_documents,
    coalesce(sum(chunk_count),0) total_chunks,coalesce(sum(source_size),0) total_bytes
  FROM (SELECT d.id,b.visibility,d.status,d.source_size,count(c.id)::bigint chunk_count
    FROM knowledge_documents d JOIN knowledge_bases b ON b.id=d.knowledge_base_id
    LEFT JOIN knowledge_chunks c ON c.document_id=d.id
    WHERE ${VISIBLE_SCOPE_SQL} GROUP BY d.id,b.visibility) visible`;

export class PostgresKnowledgeAdminService {
  constructor(private readonly database: KnowledgeDatabase) {}

  async snapshot(scope: Scope): Promise<KnowledgeSnapshot> {
    const values = scopeValues(scope);
    const [documentsResult, summaryResult] = await Promise.all([
      this.database.query<DocumentRow>(
        `${VISIBLE_DOCUMENTS_SQL} GROUP BY d.id,b.id ORDER BY d.created_at DESC LIMIT 500`, values,
      ),
      this.database.query<SummaryRow>(VISIBLE_SUMMARY_SQL, values),
    ]);
    const summary = summaryResult.rows[0]!;
    return {
      documents: documentsResult.rows.map((row) => mapDocument(row, scope.userId)),
      summary: {
        totalVersions: Number(summary.total_versions),
        activeDocuments: Number(summary.active_documents),
        privateDocuments: Number(summary.private_documents),
        sharedDocuments: Number(summary.shared_documents),
        archivedDocuments: Number(summary.archived_documents),
        totalChunks: Number(summary.total_chunks),
        totalBytes: Number(summary.total_bytes),
      },
    };
  }

  async get(scope: Scope, documentId: DocumentId): Promise<KnowledgeDocument | undefined> {
    const result = await this.database.query<DocumentRow>(
      `${VISIBLE_DOCUMENTS_SQL} AND d.id=$5 GROUP BY d.id,b.id`, [...scopeValues(scope), documentId],
    );
    return result.rows[0] ? mapDocument(result.rows[0], scope.userId) : undefined;
  }

  async archive(scope: Scope, documentId: DocumentId): Promise<KnowledgeDocument | undefined> {
    const changed = await this.database.query<{ id: string }>(
      `UPDATE knowledge_documents d SET status='deleted' FROM knowledge_bases b
       WHERE d.id=$1 AND d.knowledge_base_id=b.id AND d.status='active'
       AND b.tenant_id=$2 AND b.bot_id=$3 AND b.deployment_id=$4
       AND ${MANAGEABLE_DOCUMENT_SQL} RETURNING d.id`,
      [documentId, ...scopeValues(scope)],
    );
    if (!changed.rows[0]) return undefined;
    return this.get(scope, documentId);
  }

  async restore(scope: Scope, documentId: DocumentId): Promise<KnowledgeDocument | undefined> {
    const restored = await this.database.transaction(async (database) => {
      const row = await this.lockOwned(database, scope, documentId, "deleted");
      if (!row) return false;
      await database.query("SELECT id FROM knowledge_bases WHERE id=$1 FOR UPDATE", [row.base_id]);
      if (!await this.destinationOwned(database, row.base_id, row.document_key, scope.userId)) return false;
      await database.query(
        `UPDATE knowledge_documents SET status='superseded' WHERE knowledge_base_id=$1
         AND document_key=$2 AND status='active'`, [row.base_id, row.document_key],
      );
      await database.query(
        "UPDATE knowledge_documents SET status='active',activated_at=now() WHERE id=$1",
        [documentId],
      );
      return true;
    });
    if (!restored) return undefined;
    return this.get(scope, documentId);
  }

  async moveVisibility(
    scope: Scope,
    documentId: DocumentId,
    visibility: KnowledgeVisibility,
  ): Promise<KnowledgeDocument | undefined> {
    const changed = await this.database.transaction(async (database) => {
      const row = await this.lockOwned(database, scope, documentId);
      if (!row) return false;
      if (row.visibility === visibility) return true;
      const baseId = await this.ensureBase(database, scope, visibility);
      await database.query("SELECT id FROM knowledge_bases WHERE id=$1 FOR UPDATE", [baseId]);
      if (!await this.destinationOwned(database, baseId, row.document_key, scope.userId)) return false;
      const next = await database.query<{ version: number }>(
        `SELECT coalesce(max(version),0)::int+1 version FROM knowledge_documents
         WHERE knowledge_base_id=$1 AND document_key=$2`, [baseId, row.document_key],
      );
      if (row.status === "active") {
        await database.query(
          `UPDATE knowledge_documents SET status='superseded' WHERE knowledge_base_id=$1
           AND document_key=$2 AND status='active'`, [baseId, row.document_key],
        );
      }
      await database.query(
        "UPDATE knowledge_documents SET knowledge_base_id=$2,version=$3 WHERE id=$1",
        [documentId, baseId, next.rows[0]!.version],
      );
      return true;
    });
    if (!changed) return undefined;
    return this.get(scope, documentId);
  }

  /** 重索引源（仅创建者可取）：返回原始源路径与业务元数据。 */
  async reindexSource(scope: Scope, documentId: DocumentId): Promise<ReindexSource | undefined> {
    const row = await this.database.query<DocumentRow>(
      `${VISIBLE_DOCUMENTS_SQL} AND d.id=$5 AND d.created_by_user_id=$4
       AND d.status IN ('active','deleted','failed') GROUP BY d.id,b.id`,
      [...scopeValues(scope), documentId],
    );
    if (!row.rows[0]) return undefined;
    const item = row.rows[0];
    const details = metadataOf(item.metadata);
    return {
      scope,
      sourcePath: item.source_storage_key,
      name: item.source_name,
      mime: item.source_mime,
      visibility: item.visibility,
      documentKey: item.document_key,
      category: categoryOf(details),
      tags: tagsOf(details),
    };
  }

  /** 行锁 + 管理谓词（restore/moveVisibility 的事务起点）。 */
  private async lockOwned(
    database: KnowledgeQueryExecutor,
    scope: Scope,
    id: DocumentId,
    status?: string,
  ): Promise<(DocumentRow & { visibility: KnowledgeVisibility }) | undefined> {
    const result = await database.query<DocumentRow & { visibility: KnowledgeVisibility }>(
      `SELECT d.*,b.id base_id,b.visibility FROM knowledge_documents d JOIN knowledge_bases b
       ON b.id=d.knowledge_base_id WHERE d.id=$1 AND b.tenant_id=$2 AND b.bot_id=$3
       AND b.deployment_id=$4 AND ${MANAGEABLE_DOCUMENT_SQL}
       AND d.status IN ('active','deleted','failed')
       AND ($6::text IS NULL OR d.status=$6) FOR UPDATE`, [id, ...scopeValues(scope), status ?? null],
    );
    return result.rows[0];
  }

  /** 幂等建库 + ACL 授权（moveVisibility 目标库）。 */
  private async ensureBase(
    database: KnowledgeQueryExecutor,
    scope: Scope,
    visibility: KnowledgeVisibility,
  ): Promise<string> {
    const id = knowledgeBaseId(scope, visibility);
    const owner = visibility === "user_private" ? scope.userId : null;
    await database.query(
      `INSERT INTO knowledge_bases (id,tenant_id,bot_id,deployment_id,visibility,owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status='active'`,
      [id, scope.tenantId, scope.botId, scope.deploymentId, visibility, owner],
    );
    const principal = visibility === "user_private"
      ? ["user", scope.userId] : ["deployment", scope.deploymentId];
    await database.query(
      `INSERT INTO knowledge_acl (knowledge_base_id,principal_type,principal_id,can_read)
       VALUES ($1,$2,$3,true) ON CONFLICT (knowledge_base_id,principal_type,principal_id)
       DO UPDATE SET can_read=true`, [id, ...principal],
    );
    return id;
  }

  /** 目标库同键历史版本创建者必须全部是当前用户。 */
  private async destinationOwned(
    database: KnowledgeQueryExecutor,
    baseId: string,
    key: string,
    userId: string,
  ): Promise<boolean> {
    const owners = await database.query<{ created_by_user_id: string | null }>(
      `SELECT DISTINCT created_by_user_id FROM knowledge_documents
       WHERE knowledge_base_id=$1 AND document_key=$2`, [baseId, key],
    );
    return owners.rows.every((row) => row.created_by_user_id === userId);
  }
}
