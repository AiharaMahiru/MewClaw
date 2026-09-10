export interface UploadsConfigInput {
  maxAttachmentBytes?: number;
  maxTextFileBytes?: number;
  maxImageInputBytes?: number;
  ingestWaitMs?: number;
}

export interface ResolvedUploadsConfig {
  maxAttachmentBytes: number;
  maxTextFileBytes: number;
  maxImageInputBytes: number;
  ingestWaitMs: number;
}

interface IntegerRule {
  field: string;
  fallback: number;
  minimum: number;
  maximum: number;
}

const MEBIBYTE = 1024 * 1024;
const SECOND = 1_000;
const ATTACHMENT_BYTES_RULE: IntegerRule = {
  field: "maxAttachmentBytes", fallback: 100 * MEBIBYTE, minimum: 1, maximum: 100 * MEBIBYTE,
};
const TEXT_BYTES_RULE: IntegerRule = {
  field: "maxTextFileBytes", fallback: 10 * MEBIBYTE, minimum: 1, maximum: 10 * MEBIBYTE,
};
const IMAGE_BYTES_RULE: IntegerRule = {
  field: "maxImageInputBytes", fallback: 50 * MEBIBYTE, minimum: 1, maximum: 50 * MEBIBYTE,
};
const INGEST_WAIT_RULE: IntegerRule = {
  field: "ingestWaitMs", fallback: 60 * SECOND, minimum: SECOND, maximum: 5 * 60 * SECOND,
};

function resolveInteger(value: number | undefined, rule: IntegerRule): number {
  const resolved = value === undefined ? rule.fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < rule.minimum || resolved > rule.maximum) {
    throw new Error(`lark-uploads: ${rule.field} must be an integer in [${rule.minimum}, ${rule.maximum}]`);
  }
  return resolved;
}

/** 附件管线的磁盘、解析、图像和轮询预算都在服务注册前固定。 */
export function resolveUploadsConfig(input: UploadsConfigInput): ResolvedUploadsConfig {
  return {
    maxAttachmentBytes: resolveInteger(input.maxAttachmentBytes, ATTACHMENT_BYTES_RULE),
    maxTextFileBytes: resolveInteger(input.maxTextFileBytes, TEXT_BYTES_RULE),
    maxImageInputBytes: resolveInteger(input.maxImageInputBytes, IMAGE_BYTES_RULE),
    ingestWaitMs: resolveInteger(input.ingestWaitMs, INGEST_WAIT_RULE),
  };
}
