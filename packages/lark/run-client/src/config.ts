export interface RunClientConfigInput {
  connectTimeoutMs?: number;
  heartbeatToleranceMs?: number;
  maxEventBytes?: number;
  maxResponseBytes?: number;
}

export interface ResolvedRunClientConfig {
  connectTimeoutMs: number;
  heartbeatToleranceMs: number;
  maxEventBytes: number;
  maxResponseBytes: number;
}

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
const SECOND = 1_000;
const CONNECT_TIMEOUT_RULE: IntegerRule = {
  field: "connectTimeoutMs", fallback: 30 * SECOND, minimum: SECOND, maximum: 5 * 60 * SECOND,
};
const HEARTBEAT_TOLERANCE_RULE: IntegerRule = {
  field: "heartbeatToleranceMs", fallback: 45 * SECOND, minimum: SECOND, maximum: 5 * 60 * SECOND,
};
const EVENT_BYTES_RULE: IntegerRule = {
  field: "maxEventBytes", fallback: 64 * KIBIBYTE, minimum: KIBIBYTE, maximum: MEBIBYTE,
};
const RESPONSE_BYTES_RULE: IntegerRule = {
  field: "maxResponseBytes", fallback: 32 * MEBIBYTE, minimum: KIBIBYTE, maximum: 32 * MEBIBYTE,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-run-client: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 网络时限和 NDJSON 帧预算都在客户端注册前固定。 */
export function resolveRunClientConfig(input: RunClientConfigInput): ResolvedRunClientConfig {
  return {
    connectTimeoutMs: resolveInteger(input.connectTimeoutMs, CONNECT_TIMEOUT_RULE),
    heartbeatToleranceMs: resolveInteger(input.heartbeatToleranceMs, HEARTBEAT_TOLERANCE_RULE),
    maxEventBytes: resolveInteger(input.maxEventBytes, EVENT_BYTES_RULE),
    maxResponseBytes: resolveInteger(input.maxResponseBytes, RESPONSE_BYTES_RULE),
  };
}
