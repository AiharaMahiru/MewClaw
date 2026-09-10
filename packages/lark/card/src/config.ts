export interface CardConfigInput {
  throttleIntervalMs?: number;
  throttleBytes?: number;
  maxCardBytes?: number;
  maxRetries?: number;
}

export interface ResolvedCardConfig {
  throttleIntervalMs: number;
  throttleBytes: number;
  maxCardBytes: number;
  maxRetries: number;
}

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const KIBIBYTE = 1024;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_THROTTLE_BYTES = KIBIBYTE;
const DEFAULT_MAX_CARD_BYTES = 32 * KIBIBYTE;
const DEFAULT_MAX_RETRIES = 3;
const INTERVAL_RULE: IntegerRule = {
  field: "throttleIntervalMs", fallback: DEFAULT_INTERVAL_MS, minimum: 50, maximum: 60_000,
};
const THROTTLE_BYTES_RULE: IntegerRule = {
  field: "throttleBytes", fallback: DEFAULT_THROTTLE_BYTES, minimum: 1, maximum: DEFAULT_MAX_CARD_BYTES,
};
const CARD_BYTES_RULE: IntegerRule = {
  field: "maxCardBytes", fallback: DEFAULT_MAX_CARD_BYTES, minimum: 1, maximum: DEFAULT_MAX_CARD_BYTES,
};
const RETRIES_RULE: IntegerRule = {
  field: "maxRetries", fallback: DEFAULT_MAX_RETRIES, minimum: 0, maximum: 5,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-card: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 装载期固定投递节流和重试预算，防止无效数值退化为无界工作。 */
export function resolveCardConfig(input: CardConfigInput): ResolvedCardConfig {
  const maxCardBytes = resolveInteger(input.maxCardBytes, CARD_BYTES_RULE);
  const throttleBytes = resolveInteger(input.throttleBytes, THROTTLE_BYTES_RULE);
  if (throttleBytes > maxCardBytes) {
    throw new Error("lark-card: throttleBytes must not exceed maxCardBytes");
  }
  return {
    throttleIntervalMs: resolveInteger(input.throttleIntervalMs, INTERVAL_RULE),
    throttleBytes,
    maxCardBytes,
    maxRetries: resolveInteger(input.maxRetries, RETRIES_RULE),
  };
}
