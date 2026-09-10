/**
 * 摄入任务审计（lark-claw knowledge-ingestion-service 平移）。
 *
 * 进度单调约束：advance 仅当 status='processing' 且 progress ≤ 新值才更新；
 * 重启后 recoverInterrupted 把遗留 processing 全部置 failed(SERVICE_RESTARTED)。
 */
import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

import type { Scope } from "dsh-lark-contracts";
import type {
  DocumentId,
  IngestionRun,
  IngestionStage,
  KnowledgeCategory,
  KnowledgeVisibility,
} from "dsh-knowledge";

import type { KnowledgeDatabase } from "./database.js";

export interface CreateIngestionRun {
  visibility: KnowledgeVisibility;
  fileName: string;
  mimeType: string;
  sourceSize: number;
  category: KnowledgeCategory;
  tags: string[];
}

export interface IngestionProgress {
  stage: Exclude<IngestionStage, "queued" | "completed" | "failed">;
  progress: number;
}

interface IngestionRow extends QueryResultRow {
  id: string;
  file_name: string;
  mime_type: string;
  source_size: number | string;
  visibility: KnowledgeVisibility;
  category: KnowledgeCategory;
  tags: string[] | string;
  stage: IngestionStage;
  progress: number | string;
  status: IngestionRun["status"];
  document_id: string | null;
  error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

const SELECT_TASK = `SELECT id,file_name,mime_type,source_size,visibility,category,tags,
  stage,progress,status,document_id,error_code,created_at,updated_at,completed_at
  FROM knowledge_ingestion_jobs`;
const SCOPE_FILTER = `tenant_id=$1 AND bot_id=$2 AND deployment_id=$3
  AND user_id=$4 AND conversation_id=$5`;

function scopeValues(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, scope.userId, scope.conversationId];
}

function mapRun(row: IngestionRow): IngestionRun {
  const tags = typeof row.tags === "string" ? JSON.parse(row.tags) as unknown : row.tags;
  return {
    runId: row.id,
    visibility: row.visibility,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sourceSize: Number(row.source_size),
    category: row.category,
    tags: Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [],
    stage: row.stage,
    progress: Number(row.progress),
    status: row.status,
    documentId: row.document_id as DocumentId | null,
    errorCode: row.error_code,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}

export class PostgresKnowledgeIngestionService {
  constructor(private readonly database: KnowledgeDatabase) {}

  async create(scope: Scope, input: CreateIngestionRun): Promise<IngestionRun> {
    const id = randomUUID();
    const result = await this.database.query<IngestionRow>(
      `INSERT INTO knowledge_ingestion_jobs
       (id,tenant_id,bot_id,deployment_id,user_id,conversation_id,file_name,mime_type,
        source_size,visibility,category,tags,stage,progress,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'queued',10,'processing')
       RETURNING *`,
      [id, ...scopeValues(scope), input.fileName, input.mimeType,
        input.sourceSize, input.visibility, input.category, JSON.stringify(input.tags)],
    );
    return mapRun(result.rows[0]!);
  }

  async get(scope: Scope, id: string): Promise<IngestionRun | undefined> {
    const result = await this.database.query<IngestionRow>(
      `${SELECT_TASK} WHERE ${SCOPE_FILTER} AND id=$6`, [...scopeValues(scope), id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async list(scope: Scope, limit = 8): Promise<IngestionRun[]> {
    const result = await this.database.query<IngestionRow>(
      `${SELECT_TASK} WHERE ${SCOPE_FILTER} ORDER BY created_at DESC LIMIT $6`,
      [...scopeValues(scope), limit],
    );
    return result.rows.map(mapRun);
  }

  async advance(scope: Scope, id: string, update: IngestionProgress): Promise<void> {
    await this.database.query(
      `UPDATE knowledge_ingestion_jobs SET stage=$7,progress=$8,updated_at=now()
       WHERE ${SCOPE_FILTER} AND id=$6 AND status='processing' AND progress<=$8`,
      [...scopeValues(scope), id, update.stage, update.progress],
    );
  }

  async complete(scope: Scope, id: string, documentId: string): Promise<void> {
    await this.database.query(
      `UPDATE knowledge_ingestion_jobs SET stage='completed',progress=100,status='completed',
       document_id=$7,error_code=NULL,updated_at=now(),completed_at=now()
       WHERE ${SCOPE_FILTER} AND id=$6 AND status='processing'`,
      [...scopeValues(scope), id, documentId],
    );
  }

  async fail(scope: Scope, id: string, errorCode = "INGESTION_FAILED"): Promise<void> {
    await this.database.query(
      `UPDATE knowledge_ingestion_jobs SET stage='failed',status='failed',error_code=$7,
       updated_at=now(),completed_at=now() WHERE ${SCOPE_FILTER} AND id=$6 AND status='processing'`,
      [...scopeValues(scope), id, errorCode],
    );
  }

  async recoverInterrupted(): Promise<void> {
    await this.database.query(
      `UPDATE knowledge_ingestion_jobs SET stage='failed',status='failed',
       error_code='SERVICE_RESTARTED',updated_at=now(),completed_at=now()
       WHERE status='processing'`,
    );
  }
}
