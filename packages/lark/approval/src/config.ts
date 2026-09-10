export interface ApprovalConfigInput {
  ttlMs?: number;
  maxOptions?: number;
  maxPendingPerScope?: number;
}

export interface ResolvedApprovalConfig {
  ttlMs: number;
  maxOptions: number;
  maxPendingPerScope: number;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_OPTIONS = 4;
const DEFAULT_MAX_PENDING_PER_SCOPE = 5;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 20;
const MIN_PENDING_PER_SCOPE = 1;
const MAX_PENDING_PER_SCOPE = 100;

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const TTL_RULE: IntegerRule = { field: "ttlMs", fallback: DEFAULT_TTL_MS, minimum: MIN_TTL_MS, maximum: MAX_TTL_MS };
const OPTIONS_RULE: IntegerRule = { field: "maxOptions", fallback: DEFAULT_MAX_OPTIONS, minimum: MIN_OPTIONS, maximum: MAX_OPTIONS };
const PENDING_RULE: IntegerRule = {
  field: "maxPendingPerScope",
  fallback: DEFAULT_MAX_PENDING_PER_SCOPE,
  minimum: MIN_PENDING_PER_SCOPE,
  maximum: MAX_PENDING_PER_SCOPE,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-approval: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

export function resolveApprovalConfig(input: ApprovalConfigInput): ResolvedApprovalConfig {
  return {
    ttlMs: resolveInteger(input.ttlMs, TTL_RULE),
    maxOptions: resolveInteger(input.maxOptions, OPTIONS_RULE),
    maxPendingPerScope: resolveInteger(input.maxPendingPerScope, PENDING_RULE),
  };
}
