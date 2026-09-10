/**
 * 品牌化 ID 与解析函数（SPEC contracts.md §4.1）。
 *
 * 品牌化是纯类型手段（dsh-brand，零运行时开销）：make* 工厂用于可信同进程
 * 构造（纯 cast），parse* 解析用于跨进程/网络输入——一律视为不可信，
 * 先校验后使用。解析失败返回 typed error（ParseResult），不抛裸异常。
 */
import type { Branded } from "@deepseek-ai/dsh-brand";
import { SessionId as brandSessionId, type SessionId } from "@deepseek-ai/dsh-session";

import { LarkError } from "./errors.js";

export type TenantId = Branded<"tenant">;
export type BotId = Branded<"bot">;
export type DeploymentId = Branded<"deployment">;
/** 飞书用户 open_id。 */
export type UserId = Branded<"lark-user">;
export type ConversationId = Branded<"conversation">;
export type RunId = Branded<"run">;
/** 飞书消息 id（以平台返回为准，勿自造）。 */
export type MessageId = Branded<"lark-message">;
/** 飞书群 id。 */
export type ChatId = Branded<"lark-chat">;
export type InteractionId = Branded<"interaction">;
export type ArtifactId = Branded<"artifact">;
/** 飞书图片资源 key。 */
export type ImageKey = Branded<"lark-image">;
/** cron 投递确认用的一次性租约令牌。 */
export type DeliveryToken = Branded<"cron-delivery-token">;
/** cron 任务 id；必须是 UUID（lark-claw 语义保留）。 */
export type JobId = Branded<"job">;

/** 解析结果：非法输入返回 typed error，不抛裸异常。 */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: LarkError };

const MAX_ID_LENGTH = 256;
/** 控制字符（含 DEL）一律拒绝；换行符在列，天然防日志/NDJSON 注入。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(label: string): ParseResult<never> {
  return { ok: false, error: new LarkError("INVALID_REQUEST", "caller-bug", `invalid ${label}`) };
}

/** 通用 ID 校验：字符串、trim 后非空、≤256 字符、无控制字符。 */
function parseId(value: unknown, label: string): ParseResult<string> {
  if (typeof value !== "string") return invalid(label);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ID_LENGTH) return invalid(label);
  if (CONTROL_CHARS.test(trimmed)) return invalid(label);
  return { ok: true, value: trimmed };
}

/** 生成某个品牌的解析器（parse* 函数族）。 */
function makeParser<B extends string>(label: string): (value: unknown) => ParseResult<Branded<B>> {
  return (value) => {
    const result = parseId(value, label);
    return result.ok ? { ok: true, value: result.value as Branded<B> } : result;
  };
}

export const parseTenantId = makeParser<"tenant">("tenantId");
export const parseBotId = makeParser<"bot">("botId");
export const parseDeploymentId = makeParser<"deployment">("deploymentId");
export const parseUserId = makeParser<"lark-user">("userId");
export const parseConversationId = makeParser<"conversation">("conversationId");
export const parseRunId = makeParser<"run">("runId");
export const parseMessageId = makeParser<"lark-message">("messageId");
export const parseChatId = makeParser<"lark-chat">("chatId");
export const parseInteractionId = makeParser<"interaction">("interactionId");
export const parseArtifactId = makeParser<"artifact">("artifactId");
export const parseImageKey = makeParser<"lark-image">("imageKey");
export const parseDeliveryToken = makeParser<"cron-delivery-token">("deliveryToken");

/** DSH session id 跨 wire 时同样必须限制长度并拒绝控制字符。 */
export function parseSessionId(value: unknown): ParseResult<SessionId> {
  const result = parseId(value, "sessionId");
  return result.ok ? { ok: true, value: brandSessionId(result.value) } : result;
}

/** jobId 是 UUID：严格的八位组格式（小写十六进制 + 连字符）。 */
export function parseJobId(value: unknown): ParseResult<JobId> {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return invalid("jobId");
  return { ok: true, value: value as JobId };
}

// ---- 工厂（可信同进程构造，纯 cast；跨边界输入一律走 parse*） ----

export function makeTenantId(value: string): TenantId {
  return value as TenantId;
}
export function makeBotId(value: string): BotId {
  return value as BotId;
}
export function makeDeploymentId(value: string): DeploymentId {
  return value as DeploymentId;
}
export function makeUserId(value: string): UserId {
  return value as UserId;
}
export function makeConversationId(value: string): ConversationId {
  return value as ConversationId;
}
export function makeRunId(value: string): RunId {
  return value as RunId;
}
export function makeMessageId(value: string): MessageId {
  return value as MessageId;
}
export function makeChatId(value: string): ChatId {
  return value as ChatId;
}
export function makeInteractionId(value: string): InteractionId {
  return value as InteractionId;
}
export function makeArtifactId(value: string): ArtifactId {
  return value as ArtifactId;
}
export function makeImageKey(value: string): ImageKey {
  return value as ImageKey;
}
export function makeDeliveryToken(value: string): DeliveryToken {
  return value as DeliveryToken;
}
export function makeJobId(value: string): JobId {
  return value as JobId;
}
