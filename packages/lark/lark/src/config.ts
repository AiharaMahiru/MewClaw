export interface LarkConfigInput {
  maxResourceBytes?: number;
}

export interface ResolvedLarkConfig {
  maxResourceBytes: number;
}

const DEFAULT_MAX_RESOURCE_BYTES = 50 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;

/** 在凭证和 SDK 初始化前固定不可信资源的下载预算。 */
export function resolveLarkConfig(input: LarkConfigInput): ResolvedLarkConfig {
  const maxResourceBytes = input.maxResourceBytes === undefined
    ? DEFAULT_MAX_RESOURCE_BYTES
    : input.maxResourceBytes;
  if (!Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > MAX_RESOURCE_BYTES) {
    throw new Error(`lark: maxResourceBytes must be an integer in [1, ${MAX_RESOURCE_BYTES}]`);
  }
  return { maxResourceBytes };
}
