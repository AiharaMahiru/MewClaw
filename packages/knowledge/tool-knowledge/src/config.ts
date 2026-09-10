export interface ToolKnowledgeConfigInput {
  /** Whether to register the tool. Defaults to true. */
  enabled?: boolean;
  /** Result limit. Defaults to 5. */
  topK?: number;
  /** Candidate limit. Defaults to 20. */
  candidateCount?: number;
  /** Whether to rerank results. Defaults to true. */
  rerank?: boolean;
  /** Cooperative timeout budget. Defaults to 60 seconds. */
  timeoutMs?: number;
}

export interface ResolvedToolKnowledgeConfig {
  topK: number;
  candidateCount: number;
  rerank: boolean;
  timeoutMs: number;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_CANDIDATE_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TOP_K = 1;
const MAX_TOP_K = 20;
const MIN_CANDIDATE_COUNT = 1;
const MAX_CANDIDATE_COUNT = 100;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const TOP_K_RULE: IntegerRule = { field: "topK", fallback: DEFAULT_TOP_K, minimum: MIN_TOP_K, maximum: MAX_TOP_K };
const CANDIDATE_COUNT_RULE: IntegerRule = {
  field: "candidateCount",
  fallback: DEFAULT_CANDIDATE_COUNT,
  minimum: MIN_CANDIDATE_COUNT,
  maximum: MAX_CANDIDATE_COUNT,
};
const TIMEOUT_RULE: IntegerRule = {
  field: "timeoutMs",
  fallback: DEFAULT_TIMEOUT_MS,
  minimum: MIN_TIMEOUT_MS,
  maximum: MAX_TIMEOUT_MS,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`tool-knowledge: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

function resolveRerank(value: boolean | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new Error("tool-knowledge: rerank must be a boolean");
  return value;
}

export function resolveToolKnowledgeConfig(input: ToolKnowledgeConfigInput): ResolvedToolKnowledgeConfig {
  return {
    topK: resolveInteger(input.topK, TOP_K_RULE),
    candidateCount: resolveInteger(input.candidateCount, CANDIDATE_COUNT_RULE),
    rerank: resolveRerank(input.rerank),
    timeoutMs: resolveInteger(input.timeoutMs, TIMEOUT_RULE),
  };
}
