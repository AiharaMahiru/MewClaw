/**
 * 飞书 API 错误分类学（SPEC lark.md §6 失败模式表）。
 *
 * 本包只抛类型化 LarkApiError，不抛未分类异常；调用方按 code 决策
 * （网关转用户可见失败卡、卡片节流器退避等）。
 */

export type LarkApiErrorCode =
  | "LARK_AUTH_FAILED"
  | "LARK_TOKEN_FAILED"
  | "LARK_RATE_LIMITED"
  | "LARK_PERMISSION_DENIED"
  | "LARK_NETWORK"
  | "LARK_RESOURCE_INVALID"
  | "LARK_API_FAILED";

/** 类型化飞书错误：code + 脱敏消息（不携带令牌、密钥、用户内容）。 */
export class LarkApiError extends Error {
  constructor(
    readonly code: LarkApiErrorCode,
    message: string,
    /** 平台限流提示（毫秒）；仅 LARK_RATE_LIMITED 时可能有值。 */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LarkApiError";
  }
}

/** 平台错误码 → 本包错误码（lark-claw 语义保留；未知码归入通用失败）。 */
const PLATFORM_ERROR_MAP: Readonly<Record<number, LarkApiErrorCode>> = {
  // 应用凭证错误（app_id/secret 无效）
  99991665: "LARK_AUTH_FAILED",
  99991679: "LARK_AUTH_FAILED",
  // 令牌无效/过期/缺失
  99991661: "LARK_TOKEN_FAILED",
  99991663: "LARK_TOKEN_FAILED",
  99991664: "LARK_TOKEN_FAILED",
  99991668: "LARK_TOKEN_FAILED",
  99991671: "LARK_TOKEN_FAILED",
  // 限流（频率限制）
  99991400: "LARK_RATE_LIMITED",
  53001: "LARK_RATE_LIMITED",
  53002: "LARK_RATE_LIMITED",
  53003: "LARK_RATE_LIMITED",
  // 权限不足
  99991666: "LARK_PERMISSION_DENIED",
  99991670: "LARK_PERMISSION_DENIED",
  99991672: "LARK_PERMISSION_DENIED",
  99991673: "LARK_PERMISSION_DENIED",
};

/** SDK 抛出的错误：可能带平台错误码（数字）与 retry-after（毫秒）。 */
interface SdkFailure {
  code?: unknown;
  retryAfterMs?: unknown;
  msg?: unknown;
}

/**
 * 把 SDK 抛出的异常规约为 LarkApiError。
 * 网络类异常（无平台错误码）→ LARK_NETWORK；有码按映射表归类，否则通用失败。
 */
export function classifyError(error: unknown, operation: string): LarkApiError {
  if (error instanceof LarkApiError) return error;
  const failure = (typeof error === "object" && error !== null ? error : {}) as SdkFailure;
  const code = typeof failure.code === "number" ? failure.code : undefined;
  const retryAfterMs = typeof failure.retryAfterMs === "number" ? failure.retryAfterMs : undefined;
  if (code === undefined) {
    return new LarkApiError("LARK_NETWORK", `${operation} 网络失败`);
  }
  const mapped = PLATFORM_ERROR_MAP[code] ?? "LARK_API_FAILED";
  return new LarkApiError(mapped, `${operation} 平台错误码 ${code}`, retryAfterMs);
}
