/**
 * 全仓共享错误分类学（SPEC contracts.md §4.4）。
 *
 * 跨进程传输只允许 code + 脱敏 message，永不传堆栈；
 * 本文件是错误码的唯一 home，任何包不得自行再定义。
 */

/** 错误类别：决定网关是否替换为用户可见失败卡。 */
export type LarkErrorCategory = "user-visible" | "caller-bug" | "environment";

/** 全仓共享错误码（SPEC contracts.md §4.4 表）。 */
export type LarkErrorCode =
  | "UNAUTHORIZED_SCOPE"
  | "INVALID_REQUEST"
  | "SESSION_CREATE_FAILED"
  | "SESSION_CLAIM_INVALID"
  | "SESSION_NOT_AVAILABLE"
  | "SESSION_DIRECTORY_FAILED"
  | "RUN_TIMEOUT"
  | "QUEUE_FULL"
  | "CANCELLED"
  | "EMPTY_RESPONSE"
  | "RUNTIME_ERROR"
  | "BILLING_QUOTA_EXCEEDED";

/** 类型化错误：进程内携带完整语义；跨进程只传 {@link toWire} 结果。 */
export class LarkError extends Error {
  constructor(
    readonly code: LarkErrorCode,
    readonly category: LarkErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "LarkError";
  }
}

/** 跨进程错误形态：code + 脱敏信息，不含堆栈。 */
export interface LarkErrorWire {
  code: LarkErrorCode;
  message: string;
}

/**
 * 把任意异常规约为可跨进程传输的形态。
 * 未知异常一律按环境故障处理，只保留异常类型名（脱敏，不暴露提供方细节）。
 */
export function toWire(error: unknown): LarkErrorWire {
  if (error instanceof LarkError) {
    return { code: error.code, message: error.message };
  }
  const name = error instanceof Error ? error.name : "unknown";
  return { code: "RUNTIME_ERROR", message: `unexpected ${name}` };
}
