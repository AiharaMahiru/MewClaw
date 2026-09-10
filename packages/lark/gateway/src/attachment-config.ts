export interface GatewayAttachmentLimitsInput {
  maxBytes?: number | undefined;
  ttlMs?: number | undefined;
  maxPending?: number | undefined;
}

export interface GatewayAttachmentLimits {
  maxBytes: number;
  ttlMs: number;
  maxPending: number;
}

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const MEBIBYTE = 1024 * 1024;
const HOUR = 60 * 60 * 1_000;
const MAX_BYTES_RULE: IntegerRule = {
  field: "maxBytes", fallback: 100 * MEBIBYTE, minimum: 1, maximum: 100 * MEBIBYTE,
};
const TTL_RULE: IntegerRule = {
  field: "ttlMs", fallback: 10 * 60 * 1_000, minimum: 1, maximum: 24 * HOUR,
};
const PENDING_RULE: IntegerRule = {
  field: "maxPending", fallback: 10, minimum: 1, maximum: 100,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-gateway attachments: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 附件落盘和暂存资源限制在构造器入口统一校验。 */
export function resolveGatewayAttachmentLimits(input: GatewayAttachmentLimitsInput): GatewayAttachmentLimits {
  return {
    maxBytes: resolveInteger(input.maxBytes, MAX_BYTES_RULE),
    ttlMs: resolveInteger(input.ttlMs, TTL_RULE),
    maxPending: resolveInteger(input.maxPending, PENDING_RULE),
  };
}
