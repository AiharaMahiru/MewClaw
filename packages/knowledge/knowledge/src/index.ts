/**
 * dsh-knowledge Definition（SPEC knowledge.md）。
 *
 * 知识能力缝的契约面：`ctx.knowledge` 服务接口 + 全部数据类型。
 * 只有类型与 Context 声明合并，没有任何实现——实现由
 * dsh-knowledge-postgres（Provider）承载，模型面由
 * dsh-tool-knowledge（Consumer）承载。
 *
 * 安全模型（不变式，Provider 必须逐条落实）：
 * - ACL 过滤在查询谓词内完成（先取后滤禁止）；
 * - docId 永非所有权证据，一切操作按完整 Scope 复核；
 * - 检索结果为不可信证据（提示注入面），引用只带节选。
 */
import "@deepseek-ai/cordis";

import type { KnowledgeCitation } from "dsh-lark-contracts";
import type { Scope } from "dsh-lark-contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 知识能力缝（Provider 提供；模型工具与管理面共用同一服务）。 */
    knowledge?: Knowledge;
  }
}

/** 文档标识（品牌化；跨进程出现时须过 {@link parseDocumentId}）。 */
declare const documentIdBrand: unique symbol;
export type DocumentId = string & { readonly [documentIdBrand]: true };

/** 品牌化解析结果（wire 边界用；进程内已静态保证）。 */
export type DocumentIdParseResult =
  | { ok: true; value: DocumentId }
  | { ok: false; error: string };

/** 解析文档标识：仅接受小写 UUID 形态。 */
export function parseDocumentId(input: unknown): DocumentIdParseResult {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input)) {
    return { ok: false, error: "invalid document id" };
  }
  return { ok: true, value: input as DocumentId };
}

/** 知识可见性。 */
export type KnowledgeVisibility = "user_private" | "bot_shared";

/** 业务分类（admin 摄入用）。 */
export type KnowledgeCategory =
  | "general"
  | "product_manual"
  | "technical_spec"
  | "project_document"
  | "policy_process"
  | "faq";

/** 摄入源描述（Provider 校验路径归属/大小/MIME 白名单）。 */
export interface IngestInput {
  /** 源文件绝对路径；必须位于 Provider 的 uploadsRoot/<scopeKey>/ 内。 */
  sourcePath: string;
  /** 展示名。 */
  sourceName: string;
  /** MIME；M3 白名单为文本类（Provider 校验）。 */
  sourceMime: string;
  /** 文档键（同键新版本取代）；缺省 = sourceName。 */
  documentKey?: string;
  /** 业务分类；缺省 general。 */
  category?: KnowledgeCategory;
  /** 标签（≤8 个）。 */
  tags?: string[];
  /** 附加业务元数据（不参与 ACL）。 */
  metadata?: Record<string, unknown>;
}

/** 检索选项（缺省：topK 5 / candidate 20 / rerank true）。 */
export interface RetrieveOptions {
  topK?: number;
  candidateCount?: number;
  rerank?: boolean;
}

/** 一条检索命中（不可信证据；score 仅诊断）。 */
export interface KnowledgeHit {
  docId: DocumentId;
  documentKey: string;
  name: string;
  version: number;
  visibility: KnowledgeVisibility;
  /** chunk ordinal。 */
  chunk: number;
  text: string;
  score: number;
  citation: KnowledgeCitation;
}

/** 摄入阶段。 */
export type IngestionStage =
  | "queued"
  | "inspecting"
  | "extracting"
  | "chunking"
  | "embedding"
  | "indexing"
  | "completed"
  | "failed";

/** 摄入任务审计记录（进度单调递增；重启后遗留 processing 置 failed）。 */
export interface IngestionRun {
  runId: string;
  visibility: KnowledgeVisibility;
  fileName: string;
  mimeType: string;
  sourceSize: number;
  category: KnowledgeCategory;
  tags: string[];
  stage: IngestionStage;
  progress: number;
  status: "processing" | "completed" | "failed";
  documentId: DocumentId | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** 文档状态。 */
export type KnowledgeDocumentStatus =
  | "processing"
  | "active"
  | "superseded"
  | "failed"
  | "deleted";

/** 管理面文档视图（本 scope 可见才返回）。 */
export interface KnowledgeDocument {
  docId: DocumentId;
  baseId: string;
  documentKey: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  visibility: KnowledgeVisibility;
  status: KnowledgeDocumentStatus;
  version: number;
  chunkCount: number;
  category: KnowledgeCategory;
  tags: string[];
  createdAt: string;
  activatedAt: string | null;
  /** 当前 scope.user 是否所有者（可执行生命周期操作）。 */
  canManage: boolean;
}

/** 管理面快照（文档列表 + 汇总）。 */
export interface KnowledgeSnapshot {
  documents: KnowledgeDocument[];
  summary: {
    totalVersions: number;
    activeDocuments: number;
    privateDocuments: number;
    sharedDocuments: number;
    archivedDocuments: number;
    totalChunks: number;
    totalBytes: number;
  };
}

/**
 * 知识服务契约。
 *
 * 可见性语义：`user_private` 库归 scope.user 所有；`bot_shared` 库对同
 * tenant+bot+deployment 的全部用户可见（摄入时自动授权 deployment 主体）。
 * 生命周期操作仅 `created_by_user_id === scope.user` 的所有者可用——谓词
 * 无匹配行时返回 undefined（不泄露存在性）。
 */
export interface Knowledge {
  /** 检索：ACL 在查询谓词内；无结果返回空列表（非错误）。 */
  retrieve(scope: Scope, query: string, opts?: RetrieveOptions): Promise<KnowledgeHit[]>;
  /** 摄入：创建审计任务并异步执行管线（立即返回 queued 任务）。 */
  ingest(scope: Scope, input: IngestInput, visibility: KnowledgeVisibility): Promise<IngestionRun>;
  /** 管理面快照。 */
  snapshot(scope: Scope): Promise<KnowledgeSnapshot>;
  /** 单文档详情。 */
  getDocument(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>;
  /** 归档（软删：立即不可检索）。 */
  archive(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>;
  /** 恢复（事务内：旧 active 置 superseded，本文档置 active）。 */
  restore(scope: Scope, docId: DocumentId): Promise<KnowledgeDocument | undefined>;
  /** 改可见性（事务内跨库迁移 + 升版本）。 */
  moveVisibility(
    scope: Scope,
    docId: DocumentId,
    target: KnowledgeVisibility,
  ): Promise<KnowledgeDocument | undefined>;
  /** 重索引：从原始源重建（force 跳过同摘要去重）。 */
  reindex(scope: Scope, docId: DocumentId, opts: { force: boolean }): Promise<KnowledgeDocument | undefined>;
  /** 摄入任务审计（时间倒序）。 */
  ingestionRuns(scope: Scope, limit?: number): Promise<IngestionRun[]>;
  /** 单任务审计（管理面轮询进度）。 */
  ingestionRun(scope: Scope, runId: string): Promise<IngestionRun | undefined>;
}
