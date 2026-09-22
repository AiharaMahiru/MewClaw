/** 远程边界错误：只暴露稳定分类，不把上游响应或凭证带进消息。 */

export type RemoteErrorCode =
  | 'INVALID_ENDPOINT'
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_UNAVAILABLE'
  | 'RESOURCE_NOT_ALLOWED'
  | 'WORKSPACE_PATH_NOT_ALLOWED'
  | 'WORKSPACE_REVISION_CONFLICT'
  | 'LOCAL_WORKSPACE_DISCONNECTED'
  | 'WORKSPACE_REQUEST_MISMATCH'
  | 'STREAM_DISCONNECTED'
  | 'STREAM_FAILED'
  | 'NETWORK_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'REQUEST_TIMEOUT'
  | 'REMOTE_UNAVAILABLE'
  | (string & {});

const SAFE_CODE = /^[A-Z][A-Z0-9_./-]{0,96}$/u;

const PUBLIC_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_ENDPOINT: '远程地址无效',
  AUTH_REQUIRED: '远程登录已失效，请重新登录',
  INVALID_CREDENTIALS: '邮箱或密码错误',
  FORBIDDEN: '远程操作未获授权',
  CSRF_INVALID: '远程会话校验失败，请重试',
  QUOTA_EXCEEDED: '额度不足',
  MODEL_UNAVAILABLE: '模型当前不可用',
  RESOURCE_NOT_ALLOWED: '资源不属于当前账户',
  WORKSPACE_PATH_NOT_ALLOWED: '工作区路径不在允许范围内',
  WORKSPACE_REVISION_CONFLICT: '工作区状态已变化，请刷新后重试',
  LOCAL_WORKSPACE_DISCONNECTED: '本地工作区已断开',
  WORKSPACE_REQUEST_MISMATCH: '本地工作区请求状态不匹配',
  STREAM_DISCONNECTED: '远程流连接已断开',
  STREAM_FAILED: '远程流执行失败',
  NETWORK_UNAVAILABLE: '无法连接 dsh Web',
  INVALID_RESPONSE: 'dsh Web 返回了无法识别的响应',
  REQUEST_TIMEOUT: '远程请求超时',
  REMOTE_UNAVAILABLE: '远程服务暂时不可用',
};

export class RemoteClientError extends Error {
  readonly code: RemoteErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RemoteErrorCode, options: {
    status?: number;
    retryable?: boolean;
    details?: Readonly<Record<string, unknown>>;
  } = {}) {
    const safe = normalizeErrorCode(code);
    super(PUBLIC_MESSAGES[safe] ?? '远程操作失败');
    this.name = 'RemoteClientError';
    this.code = safe;
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? isRetryableCode(safe);
    this.details = options.details ?? {};
  }
}

export function normalizeErrorCode(value: unknown, fallback = 'REMOTE_UNAVAILABLE'): RemoteErrorCode {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim().toUpperCase();
  return SAFE_CODE.test(candidate) ? candidate : fallback;
}

export function isRetryableCode(code: string): boolean {
  return code === 'NETWORK_UNAVAILABLE'
    || code === 'REQUEST_TIMEOUT'
    || code === 'REMOTE_UNAVAILABLE'
    || code === 'STREAM_DISCONNECTED'
    || code === 'WORKSPACE_BRIDGE_UNAVAILABLE';
}

export function isRemoteClientError(value: unknown): value is RemoteClientError {
  return value instanceof RemoteClientError;
}

/** 将 HTTP/RPC 错误体压缩为稳定错误；绝不携带原始 message、body 或 headers。 */
export function errorFromWire(value: unknown, status?: number): RemoteClientError {
  let code: unknown;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const directError = record.error;
    code = typeof directError === 'object' && directError !== null && !Array.isArray(directError)
      ? (directError as Record<string, unknown>).code
      : directError ?? record.code;
    const result = record.result;
    if (code === undefined && result && typeof result === 'object' && !Array.isArray(result)) {
      const error = (result as Record<string, unknown>).error;
      if (error && typeof error === 'object' && !Array.isArray(error)) code = (error as Record<string, unknown>).code;
    }
  }
  const normalized = normalizeErrorCode(code, status === 401 ? 'AUTH_REQUIRED' : status === 403 ? 'FORBIDDEN' : 'REMOTE_UNAVAILABLE');
  return new RemoteClientError(normalized, { ...(status === undefined ? {} : { status }), retryable: status !== undefined && status >= 500 });
}

export function assertNever(value: never): never {
  throw new RemoteClientError('INVALID_RESPONSE', { details: { kind: typeof value } });
}
