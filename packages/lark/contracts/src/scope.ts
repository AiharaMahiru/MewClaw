/**
 * Scope：飞书平台的运行上下文（tenant/bot/deployment/user/conversation）。
 *
 * Scope 是不可信输入：一切跨进程进入的 Scope 都要过 {@link parseScope}
 * （wire 边界校验，严格模式拒绝未知键）。进程内比较用 {@link scopeEquals}。
 */
import { createHash } from "node:crypto";

import { LarkError } from "./errors.js";
import {
  parseBotId,
  parseConversationId,
  parseDeploymentId,
  parseTenantId,
  parseUserId,
  type BotId,
  type ConversationId,
  type DeploymentId,
  type ParseResult,
  type TenantId,
  type UserId,
} from "./ids.js";

export interface Scope {
  tenantId: TenantId;
  botId: BotId;
  deploymentId: DeploymentId;
  userId: UserId;
  conversationId: ConversationId;
}

const SCOPE_KEYS = new Set(["tenantId", "botId", "deploymentId", "userId", "conversationId"]);

function invalid(message: string): ParseResult<Scope> {
  return { ok: false, error: new LarkError("INVALID_REQUEST", "caller-bug", message) };
}

/**
 * 严格解析 Scope：非对象/数组拒绝、字段缺失或未知键拒绝（防拼写错误
 * 静默丢字段）、逐字段过品牌化 ID 校验。首个失败即返回。
 */
export function parseScope(input: unknown): ParseResult<Scope> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("invalid scope: expected object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SCOPE_KEYS.has(key)) return invalid(`invalid scope: unknown key ${key}`);
  }
  const tenantId = parseTenantId(record.tenantId);
  if (!tenantId.ok) return tenantId;
  const botId = parseBotId(record.botId);
  if (!botId.ok) return botId;
  const deploymentId = parseDeploymentId(record.deploymentId);
  if (!deploymentId.ok) return deploymentId;
  const userId = parseUserId(record.userId);
  if (!userId.ok) return userId;
  const conversationId = parseConversationId(record.conversationId);
  if (!conversationId.ok) return conversationId;
  return { ok: true, value: { tenantId: tenantId.value, botId: botId.value, deploymentId: deploymentId.value, userId: userId.value, conversationId: conversationId.value } };
}

/**
 * Scope 的确定性哈希（lark-claw 语义保留）：五字段以 NUL 分隔后 SHA-256。
 * 用于工作区目录名（.workspaces/<scopeKey>）与会话键派生，不作为保密依据。
 */
export function scopeKey(scope: Scope): string {
  return createHash("sha256")
    .update([
      scope.tenantId,
      scope.botId,
      scope.deploymentId,
      scope.userId,
      scope.conversationId,
    ].join("\0"))
    .digest("hex");
}

/** 由完整 Scope + generation 派生 Feishu deterministic session id。 */
export function deterministicSessionIdForScope(scope: Scope, generation: number): string {
  return `session-${scopeKey(scope)}${generation > 0 ? `:${generation}` : ""}`;
}

/** 结构化相等：逐字段比较（字段顺序固定，无需排序）。 */
export function scopeEquals(a: Scope, b: Scope): boolean {
  return a.tenantId === b.tenantId
    && a.botId === b.botId
    && a.deploymentId === b.deploymentId
    && a.userId === b.userId
    && a.conversationId === b.conversationId;
}
