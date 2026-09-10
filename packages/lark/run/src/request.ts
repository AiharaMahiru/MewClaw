/**
 * RunRequest wire 校验（SPEC lark-run.md §3/§7）。
 *
 * worker 的 HTTP 边界：请求体是不信任输入——runId/scope 走 contracts
 * 品牌化解析，prompt 做非空与长度上限校验，未知字段拒绝。
 */
import {
  LarkError,
  MAX_SESSION_GENERATION,
  parseMessageId,
  parseRunAttachments,
  parseRunId,
  parseScope,
  scopeKey,
  type ParseResult,
  type RunId,
  type RunProfile,
  type RunRequest,
  type Scope,
} from "dsh-lark-contracts";

const MAX_PROMPT_LENGTH = 32_000;
const MAX_BODY_BYTES = 1024 * 1024;
const RUN_PROFILES = new Set(["quick", "standard", "long"]);

function invalid(message: string): ParseResult<never> {
  return { ok: false, error: new LarkError("INVALID_REQUEST", "caller-bug", message) };
}

/** HTTP 请求体大小上限（防超大帧）。 */
export const RUN_BODY_BYTES_LIMIT = MAX_BODY_BYTES;

/**
 * 严格解析 RunRequest：未知键拒绝、prompt 非空且 ≤32KiB、profile 白名单。
 * 返回的 runId/scope 已是品牌化值。
 */
export function parseRunRequest(input: unknown): ParseResult<RunRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("invalid run request: expected object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["runId", "scope", "messageId", "prompt", "profile", "sessionGeneration", "attachments"].includes(key)) {
      return invalid(`invalid run request: unknown key ${key}`);
    }
  }
  const runId = parseRunId(record.runId);
  if (!runId.ok) return runId;
  const scope = parseScope(record.scope);
  if (!scope.ok) return scope;
  const messageId = parseMessageId(record.messageId);
  if (!messageId.ok) return messageId;
  if (typeof record.prompt !== "string" || record.prompt.trim().length === 0) {
    return invalid("invalid run request: prompt must be a non-empty string");
  }
  if (record.prompt.length > MAX_PROMPT_LENGTH) {
    return invalid(`invalid run request: prompt exceeds ${MAX_PROMPT_LENGTH} chars`);
  }
  if (record.profile !== undefined
    && (typeof record.profile !== "string" || !RUN_PROFILES.has(record.profile))) {
    return invalid("invalid run request: bad profile");
  }
  if (record.sessionGeneration !== undefined
    && (typeof record.sessionGeneration !== "number" || !Number.isInteger(record.sessionGeneration)
      || record.sessionGeneration < 0 || record.sessionGeneration > MAX_SESSION_GENERATION)) {
    return invalid("invalid run request: bad sessionGeneration");
  }
  // 附件：数组整体非法即拒绝整个请求（fail closed；归属按 scopeKey 前缀先验）。
  let attachments: RunRequest["attachments"];
  if (record.attachments !== undefined) {
    const parsed = parseRunAttachments(record.attachments, scopeKey(scope.value));
    if (!parsed) return invalid("invalid run request: bad attachments");
    attachments = parsed;
  }
  return {
    ok: true,
    value: {
      runId: runId.value,
      scope: scope.value,
      messageId: messageId.value,
      prompt: record.prompt,
      ...(record.profile ? { profile: record.profile as RunProfile } : {}),
      ...(record.sessionGeneration !== undefined ? { sessionGeneration: record.sessionGeneration } : {}),
      ...(attachments ? { attachments } : {}),
    },
  };
}

export type { RunId, RunProfile, Scope };
