export interface LarkWsConfigInput {
  failureWindowMs?: number;
  healthPublishIntervalMs?: number;
}

export interface ResolvedLarkWsConfig {
  failureWindowMs: number;
  healthPublishIntervalMs: number;
}

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const SECOND = 1_000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;
const FAILURE_WINDOW_RULE: IntegerRule = {
  field: "failureWindowMs", fallback: 5 * 60 * SECOND, minimum: SECOND, maximum: DAY,
};
const HEALTH_PUBLISH_RULE: IntegerRule = {
  field: "healthPublishIntervalMs", fallback: 30 * SECOND, minimum: SECOND, maximum: HOUR,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-ws: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 将连接失败窗口和健康心跳限制为有界安全整数。 */
export function resolveLarkWsConfig(input: LarkWsConfigInput): ResolvedLarkWsConfig {
  return {
    failureWindowMs: resolveInteger(input.failureWindowMs, FAILURE_WINDOW_RULE),
    healthPublishIntervalMs: resolveInteger(input.healthPublishIntervalMs, HEALTH_PUBLISH_RULE),
  };
}
