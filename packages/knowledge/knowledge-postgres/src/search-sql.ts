/**
 * 混合检索 SQL（lark-claw knowledge-search-sql 平移，谓词一字不改）。
 *
 * ACL 过滤在查询内完成（硬边界）：allowed_bases CTE 先按
 * tenant/bot/deployment + owner/ACL 谓词收窄，向量/词法候选都只能
 * 来自该集合——先取后滤在结构上不可能。
 *
 * 参数序固定：$1 tenant、$2 bot、$3 deployment、$4 user、
 * $5 embeddingModel、$6 queryEmbedding(vector)、$7 queryText、$8 limit。
 */
export const SEARCH_KNOWLEDGE_SQL = `
WITH allowed_bases AS MATERIALIZED (
  SELECT kb.id, kb.visibility
  FROM knowledge_bases kb
  WHERE kb.tenant_id = $1 AND kb.bot_id = $2 AND kb.deployment_id = $3
    AND kb.status = 'active'
    AND (
      (kb.visibility = 'user_private' AND kb.owner_user_id = $4)
      OR (kb.visibility = 'bot_shared' AND EXISTS (
        SELECT 1 FROM knowledge_acl acl
        WHERE acl.knowledge_base_id = kb.id AND acl.can_read = true
          AND ((acl.principal_type = 'deployment' AND acl.principal_id = $3)
            OR (acl.principal_type = 'user' AND acl.principal_id = $4))
      ))
    )
), allowed_chunks AS MATERIALIZED (
  SELECT c.*, d.source_name, d.source_storage_key, d.document_key, d.version, ab.visibility
  FROM allowed_bases ab
  JOIN knowledge_documents d ON d.knowledge_base_id = ab.id AND d.status = 'active'
  JOIN knowledge_chunks c ON c.document_id = d.id AND c.embedding_model = $5
), text_vector_hits AS (
  SELECT id, row_number() OVER (ORDER BY embedding <=> $6::vector) AS rank,
    (1 - (embedding <=> $6::vector))::float8 AS score
  FROM allowed_chunks ORDER BY embedding <=> $6::vector LIMIT $8
), visual_vector_hits AS (
  SELECT id, row_number() OVER (ORDER BY visual_embedding <=> $6::vector) AS rank,
    (1 - (visual_embedding <=> $6::vector))::float8 AS score
  FROM allowed_chunks WHERE visual_embedding IS NOT NULL
  ORDER BY visual_embedding <=> $6::vector LIMIT $8
), lexical_hits AS (
  SELECT id, row_number() OVER (
      ORDER BY ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $7)) DESC
    ) AS rank,
    ts_rank_cd(content_tsv, websearch_to_tsquery('simple', $7))::float8 AS score
  FROM allowed_chunks
  WHERE content_tsv @@ websearch_to_tsquery('simple', $7)
  ORDER BY score DESC LIMIT $8
), fused AS (
  SELECT id, max(vector_score)::float8 AS vector_score,
    max(lexical_score)::float8 AS lexical_score,
    sum(reciprocal_rank)::float8 AS fused_score
  FROM (
    SELECT id, score AS vector_score, 0::float8 AS lexical_score,
      1.0 / (60 + rank) AS reciprocal_rank FROM text_vector_hits
    UNION ALL
    SELECT id, score, 0::float8, 1.0 / (60 + rank) FROM visual_vector_hits
    UNION ALL
    SELECT id, 0::float8, score, 1.0 / (60 + rank) FROM lexical_hits
  ) hits GROUP BY id
)
SELECT c.id AS chunk_id, c.document_id, c.document_key, c.version,
  c.source_name AS document_title,
  c.source_storage_key AS storage_key, c.visibility, c.ordinal, c.content,
  f.vector_score, f.lexical_score, f.fused_score, c.metadata
FROM fused f JOIN allowed_chunks c ON c.id = f.id
ORDER BY f.fused_score DESC, c.id LIMIT $8`;
