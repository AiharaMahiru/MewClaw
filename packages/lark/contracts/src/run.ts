/**
 * 运行与控制契约（SPEC contracts.md §4.3）：网关 ↔ worker 的 wire 类型。
 *
 * 这些类型定义跨进程消息面；解析与校验在各自进程的 wire 边界完成
 * （网关侧 dsh-lark-run-client，worker 侧 dsh-lark-run）。
 */
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";

import type { RunAttachment } from "./attachments.js";
import type { LarkErrorWire } from "./errors.js";
import type {
  BotId,
  ArtifactId,
  DeliveryToken,
  DeploymentId,
  JobId,
  MessageId,
  RunId,
  TenantId,
  UserId,
} from "./ids.js";
import type { Scope } from "./scope.js";

/** 运行档位（lark-claw runtime-profile 语义保留）。 */
export type RunProfile = "quick" | "standard" | "long";

/** `/clear` 会话代次在 Gateway 状态与 Worker wire 之间共享的最大值。 */
export const MAX_SESSION_GENERATION = 1_000_000;

/** 单次交付物及图片读取的跨进程大小上限。 */
export const MAX_ARTIFACT_BYTES = 30 * 1024 * 1024;
const ARTIFACT_NAME_PATTERN = /^[^\\/\u0000-\u001f\u007f]{1,255}$/;
const ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** Worker 与 Gateway 都认可的 raster 图片 MIME。 */
export const IMAGE_ARTIFACT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type ImageArtifactMimeType = (typeof IMAGE_ARTIFACT_MIME_TYPES)[number];

/** 顶层交付物名：不允许路径、隐藏项、控制字符和附件物化目录。 */
export function isArtifactName(value: unknown): value is string {
  return typeof value === "string"
    && ARTIFACT_NAME_PATTERN.test(value)
    && value === value.trim()
    && !value.startsWith(".")
    && value !== "uploads";
}

/** SHA-256 摘要只接受小写完整十六进制。 */
export function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_DIGEST_PATTERN.test(value);
}

/** MIME 由 Worker 实际字节检测后给出，Gateway 不自行猜测。 */
export function isImageArtifactMimeType(value: unknown): value is ImageArtifactMimeType {
  return typeof value === "string"
    && (IMAGE_ARTIFACT_MIME_TYPES as readonly string[]).includes(value);
}

/** 网关请求 Worker 读取时的完整 artifact 证据，绝不含路径。 */
export interface ArtifactReadRequest {
  scope: Scope;
  artifactId: ArtifactId;
  name: string;
  digest: string;
  bytes: number;
}

/** Worker 完整重验后才会返回的图片字节。 */
export interface ArtifactImage {
  bytes: Uint8Array;
  mimeType: ImageArtifactMimeType;
}

/** 网关 → worker 的运行请求。 */
export interface RunRequest {
  runId: RunId;
  scope: Scope;
  /** 触发本次运行的飞书消息 id（写入 lark/message/in 的来源记录）。 */
  messageId: MessageId;
  /** 非空。 */
  prompt: string;
  profile?: RunProfile;
  /**
   * 会话代次（/clear 递增）：worker 据此派生 sessionId
   * （session-<scopeKey>[:<代次>]），缺省 0 = 初始会话。
   */
  sessionGeneration?: number;
  /** 本次运行携带的附件（M3 附件管线；上限 MAX_RUN_ATTACHMENTS）。 */
  attachments?: RunAttachment[];
}

/**
 * NDJSON 桥接行（ADR-4）：worker 流出的 session 事件 + 运行信封。
 * 网关对每一行先验 envelope（runId + 完整 Scope 与提交一致）再消费。
 * 心跳是空行，不是本类型的实例。
 */
export type RunStreamItem = {
  envelope: {
    runId: RunId;
    scope: Scope;
  };
} & (
  | { event: SessionEvent; assistant?: never }
  | { assistant: { turn: number; step: number; text: string }; event?: never }
);

/**
 * NDJSON 桥接的终止行：每流恰好一行且是最后一行。
 * outcome 要么是 OK，要么是分类错误（LarkErrorWire，code + 脱敏信息）。
 */
export interface RunStreamDone {
  envelope: {
    runId: RunId;
    scope: Scope;
  };
  outcome: { code: "OK" } | LarkErrorWire;
}

/** 会话概览查询（网关 -> worker）；完整 Scope 是唯一授权上下文。 */
export interface SessionOverviewRequest {
  scope: Scope;
  /** `/clear` 维护的非负会话代次。 */
  sessionGeneration: number;
}

/** 会话目录所有操作的完整授权上下文。 */
export interface SessionDirectoryRequest {
  scope: Scope;
  sessionGeneration: number;
}

/** Web 生成的一次性 claim code。 */
export interface SessionClaimRequest extends SessionDirectoryRequest {
  code: string;
}

/** sessionId 只负责定位；Worker 必须重新验证它属于当前 Scope。 */
export interface SessionUseRequest extends SessionDirectoryRequest {
  sessionId: SessionId;
}

export interface SessionDirectoryEntry {
  sessionId: SessionId;
  selected: boolean;
  claimedAt: string;
  lastUsedAt: string;
}

export type SessionDirectoryCurrent =
  | { mode: "deterministic" }
  | { mode: "shared"; sessionId: SessionId };

export interface SessionDirectoryList {
  sessions: SessionDirectoryEntry[];
}

export const SESSION_CLAIM_CODE_LENGTH = 24;
const SESSION_CLAIM_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export function isSessionClaimCode(input: unknown): input is string {
  return typeof input === "string" && SESSION_CLAIM_CODE_PATTERN.test(input);
}

/** 持久化会话中的累计模型用量。 */
export interface SessionOverviewUsage {
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/** worker 返回的只读会话投影；不存在时不泄露其他 Scope 的元数据。 */
export type SessionOverview = { exists: false } | {
  exists: true;
  todos: TodoItem[];
  usage: SessionOverviewUsage;
  lastActivityAt?: string;
};

/** 网关 → worker 的确定性 cron 控制（M4 上线，dsh-lark-cron 定义语义）。 */
export interface CronControlCommand {
  kind: "list" | "get" | "update" | "start" | "stop" | "delete";
  /** 操作 Scope（管理授权边界：tenant/bot/deployment/user；conversation 为任务范围）。 */
  scope: Scope;
  /** 必须通过 parseJobId 校验（UUID）。 */
  jobId?: JobId;
  /** 每 kind 单独 schema 校验（update: {task?, schedule?}）。 */
  payload?: unknown;
}

/** 网关 → worker 的 cron 投递认领请求（outbox at-least-once）。 */
export interface CronDeliveryClaimRequest {
  tenantId: TenantId;
  botId: BotId;
  deploymentId: DeploymentId;
  /** 授权用户白名单（只认领这些用户的任务投递）。 */
  userIds: UserId[];
}

/** 一条待投递的 cron 运行结果（payload 不可信展示内容，网关先验 scope）。 */
export interface CronDelivery {
  runId: RunId;
  deliveryToken: DeliveryToken;
  scope: Scope;
  task: string;
  status: "completed" | "failed";
  scheduledFor: string;
  finishedAt: string;
  output: string;
  error?: string;
}

/** 投递确认（send-before-ack：发送成功后才确认）。 */
export interface CronDeliveryAckRequest {
  runId: RunId;
  deliveryToken: DeliveryToken;
}
