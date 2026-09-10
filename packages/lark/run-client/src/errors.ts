/** 桥接客户端可公开上报的脱敏错误码。 */
export type RunClientErrorCode =
  | "CONNECT_FAILED"
  | "STREAM_BROKEN"
  | "STREAM_SCHEMA_ERROR"
  | "RESPONSE_SCHEMA_ERROR"
  | "HTTP_ERROR";

/** 桥接客户端类型化错误：不携带事件正文或提供方细节。 */
export class RunClientError extends Error {
  constructor(
    readonly code: RunClientErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RunClientError";
  }
}
