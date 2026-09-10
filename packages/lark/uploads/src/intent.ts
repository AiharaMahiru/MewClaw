/**
 * 摄入意图解析（lark-claw attachment-prompt-preparer 正则逐条平移）。
 *
 * 语义：分句后逐句判定——句内出现知识库词 + 摄入动词且无否定 → 摄入意图；
 * 公共/共享知识库目标且无共享否定 → bot_shared，否则 user_private。
 */
export type IngestionVisibility = "user_private" | "bot_shared";

export interface IngestionIntent {
  visibility: IngestionVisibility;
}

const KNOWLEDGE_TERM = /知识库|knowledge\s+base/i;
const INGEST_ACTION = /添加|加入|保存|存入|录入|导入|收录|add|save|store|import/i;
const INGEST_NEGATION = /(?:不要|别|无需|不必|禁止)[^，。,.]{0,24}(?:添加|加入|保存|存入|录入|导入|收录)|(?:do\s+not|don't|never)[^,.]{0,32}(?:add|save|store|import)/i;
const SHARED_TARGET = /公共知识库|共享知识库|公用知识库|public\s+knowledge\s+base|shared\s+knowledge\s+base|bot_shared/i;
const SHARED_NEGATION = /(?:不要|别|不|非)[^，。,.]{0,16}(?:公共|共享|公用)|(?:do\s+not|don't|not)[^,.]{0,24}(?:public|shared)/i;
const CLAUSE_SEPARATOR = /[，。,.；;]|\b(?:but|instead)\b|而是/i;

function requestsKnowledgeIngestion(clause: string): boolean {
  return KNOWLEDGE_TERM.test(clause)
    && INGEST_ACTION.test(clause)
    && !INGEST_NEGATION.test(clause);
}

function sharedVisibility(clause: string): IngestionVisibility {
  return SHARED_TARGET.test(clause) && !SHARED_NEGATION.test(clause)
    ? "bot_shared"
    : "user_private";
}

/** 解析摄入意图；无意图返回 undefined（仅讨论知识库不触发）。 */
export function parseKnowledgeIngestionIntent(message: string): IngestionIntent | undefined {
  let requested = false;
  let visibility: IngestionVisibility = "user_private";
  for (const clause of message.split(CLAUSE_SEPARATOR)) {
    if (requestsKnowledgeIngestion(clause)) {
      requested = true;
      visibility = sharedVisibility(clause);
    } else if (requested && SHARED_NEGATION.test(clause)) {
      visibility = "user_private";
    } else if (requested && SHARED_TARGET.test(clause)) {
      visibility = "bot_shared";
    }
  }
  return requested ? { visibility } : undefined;
}
