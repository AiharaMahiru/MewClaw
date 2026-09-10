import {
  isArtifactDigest,
  isArtifactName,
  isSessionClaimCode,
  parseBotId,
  parseArtifactId,
  parseDeliveryToken,
  parseDeploymentId,
  parseInteractionId,
  parseJobId,
  parseRunId,
  parseScope,
  parseSessionId,
  parseTenantId,
  parseUserId,
  MAX_SESSION_GENERATION,
  MAX_ARTIFACT_BYTES,
  type ArtifactReadRequest,
  type CronControlCommand,
  type CronDeliveryAckRequest,
  type CronDeliveryClaimRequest,
  type InteractionId,
  type RunId,
  type Scope,
  type SessionOverviewRequest,
  type SessionClaimRequest,
  type SessionDirectoryRequest,
  type SessionUseRequest,
} from "dsh-lark-contracts";

import { asRecord, HttpInputError } from "./http-utils.js";

const CRON_KINDS = new Set(["list", "get", "update", "start", "stop", "delete"]);
const MAX_INTERACTION_SELECTIONS = 64;
const MAX_INTERACTION_TEXT_LENGTH = 4_000;
const INTERACTION_BODY_FIELDS = new Set(["scope", "interactionId", "answer"]);
const INTERACTION_ANSWER_FIELDS = new Set(["selected", "custom"]);
const CRON_CLAIM_FIELDS = new Set(["tenantId", "botId", "deploymentId", "userIds"]);
const CRON_ACK_FIELDS = new Set(["runId", "deliveryToken"]);
const ARTIFACT_READ_FIELDS = new Set(["scope", "artifactId", "name", "digest", "bytes"]);
const SESSION_DIRECTORY_FIELDS = new Set(["scope", "sessionGeneration"]);
const SESSION_CLAIM_FIELDS = new Set(["scope", "sessionGeneration", "code"]);
const SESSION_USE_FIELDS = new Set(["scope", "sessionGeneration", "sessionId"]);
const MAX_CRON_CLAIM_USERS = 10_000;

export interface InteractionResolution {
  scope: Scope;
  interactionId: InteractionId;
  answer: { selected: string[]; custom?: string };
}

export function parseSessionOverviewBody(input: unknown): SessionOverviewRequest {
  const record = asRecord(input);
  if (!record || !hasExactFields(record, SESSION_DIRECTORY_FIELDS)) {
    throw new HttpInputError(400, "scope 或 sessionGeneration 非法");
  }
  const scope = parseScope(record?.scope);
  const generation = record?.sessionGeneration;
  const validGeneration = typeof generation === "number"
    && Number.isSafeInteger(generation)
    && generation >= 0
    && generation <= MAX_SESSION_GENERATION;
  if (!scope.ok || !validGeneration) {
    throw new HttpInputError(400, "scope 或 sessionGeneration 非法");
  }
  return { scope: scope.value, sessionGeneration: generation };
}

export function parseSessionDirectoryBody(input: unknown): SessionDirectoryRequest {
  return parseSessionOverviewBody(input);
}

export function parseSessionClaimBody(input: unknown): SessionClaimRequest {
  const record = asRecord(input);
  if (!record || !hasExactFields(record, SESSION_CLAIM_FIELDS) || !isSessionClaimCode(record.code)) {
    throw new HttpInputError(400, "会话分享码请求非法");
  }
  return { ...parseSessionOverviewBody({ scope: record.scope, sessionGeneration: record.sessionGeneration }), code: record.code };
}

export function parseSessionUseBody(input: unknown): SessionUseRequest {
  const record = asRecord(input);
  const sessionId = parseSessionId(record?.sessionId);
  if (!record || !hasExactFields(record, SESSION_USE_FIELDS) || !sessionId.ok) {
    throw new HttpInputError(400, "会话选择请求非法");
  }
  return {
    ...parseSessionOverviewBody({ scope: record.scope, sessionGeneration: record.sessionGeneration }),
    sessionId: sessionId.value,
  };
}

/** 图片读取仅接受完整且可复核的 artifact 证据；路径不属于 wire。 */
export function parseArtifactReadBody(input: unknown): ArtifactReadRequest {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, ARTIFACT_READ_FIELDS)) {
    throw new HttpInputError(400, "图片 artifact 请求非法");
  }
  const scope = parseScope(record.scope);
  const artifactId = parseArtifactId(record.artifactId);
  const bytes = record.bytes;
  if (!scope.ok || !artifactId.ok || !isArtifactName(record.name)
    || !isArtifactDigest(record.digest) || typeof bytes !== "number"
    || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_ARTIFACT_BYTES) {
    throw new HttpInputError(400, "图片 artifact 请求非法");
  }
  return {
    scope: scope.value,
    artifactId: artifactId.value,
    name: record.name,
    digest: record.digest,
    bytes,
  };
}

function hasOnlyFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasExactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).length === allowed.size && hasOnlyFields(record, allowed);
}

function parseClaimUserIds(input: unknown): CronDeliveryClaimRequest["userIds"] | undefined {
  if (!Array.isArray(input) || input.length > MAX_CRON_CLAIM_USERS) return undefined;
  const userIds: CronDeliveryClaimRequest["userIds"] = [];
  for (const value of input) {
    const userId = parseUserId(value);
    if (!userId.ok) return undefined;
    userIds.push(userId.value);
  }
  return userIds;
}

function parseAnswer(input: unknown): InteractionResolution["answer"] | undefined {
  const answer = asRecord(input);
  if (!answer || !hasOnlyFields(answer, INTERACTION_ANSWER_FIELDS)
    || !Array.isArray(answer.selected) || answer.selected.length > MAX_INTERACTION_SELECTIONS) return undefined;
  if (answer.selected.some((item) => typeof item !== "string" || item.length > MAX_INTERACTION_TEXT_LENGTH)) return undefined;
  const custom = answer.custom;
  if (custom !== undefined && (typeof custom !== "string" || custom.length === 0 || custom.length > MAX_INTERACTION_TEXT_LENGTH)) return undefined;
  if (answer.selected.length === 0 && custom === undefined) return undefined;
  return {
    selected: answer.selected as string[],
    ...(typeof custom === "string" ? { custom } : {}),
  };
}

export function parseInteractionBody(input: unknown): InteractionResolution {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, INTERACTION_BODY_FIELDS)) {
    throw new HttpInputError(400, "scope、interactionId 或 answer 结构非法");
  }
  const scope = parseScope(record?.scope);
  const interactionId = parseInteractionId(record?.interactionId);
  const answer = parseAnswer(record?.answer);
  if (!scope.ok || !interactionId.ok || !answer) {
    throw new HttpInputError(400, "scope、interactionId 或 answer 结构非法");
  }
  return { scope: scope.value, interactionId: interactionId.value, answer };
}

function parseCronKind(record: Record<string, unknown>): CronControlCommand["kind"] {
  if (typeof record.kind !== "string" || !CRON_KINDS.has(record.kind)) {
    throw new HttpInputError(400, "cron 控制命令非法");
  }
  return record.kind as CronControlCommand["kind"];
}

function parseOptionalJobId(record: Record<string, unknown>): CronControlCommand["jobId"] {
  if (record.jobId === undefined) return undefined;
  const jobId = parseJobId(record.jobId);
  if (!jobId.ok) throw new HttpInputError(400, "jobId 非法");
  return jobId.value;
}

export function parseCronControlBody(input: unknown): CronControlCommand {
  const record = asRecord(input);
  if (!record) throw new HttpInputError(400, "cron 控制命令非法");
  const kind = parseCronKind(record);
  const scope = parseScope(record.scope);
  if (!scope.ok) throw new HttpInputError(400, "scope 非法");
  const command: CronControlCommand = { kind, scope: scope.value };
  const jobId = parseOptionalJobId(record);
  if (jobId) command.jobId = jobId;
  if (record.payload !== undefined) command.payload = record.payload;
  return command;
}

export function parseCronClaimBody(input: unknown): CronDeliveryClaimRequest {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, CRON_CLAIM_FIELDS)) {
    throw new HttpInputError(400, "投递认领请求非法");
  }
  const tenantId = parseTenantId(record.tenantId);
  const botId = parseBotId(record.botId);
  const deploymentId = parseDeploymentId(record.deploymentId);
  const userIds = parseClaimUserIds(record.userIds);
  if (!tenantId.ok || !botId.ok || !deploymentId.ok || !userIds) {
    throw new HttpInputError(400, "投递认领请求非法");
  }
  return {
    tenantId: tenantId.value,
    botId: botId.value,
    deploymentId: deploymentId.value,
    userIds,
  };
}

export function parseCronAckBody(input: unknown): CronDeliveryAckRequest {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, CRON_ACK_FIELDS)) {
    throw new HttpInputError(400, "投递确认请求非法");
  }
  const runId = parseRunId(record.runId);
  const deliveryToken = parseDeliveryToken(record.deliveryToken);
  if (!runId.ok || !deliveryToken.ok) throw new HttpInputError(400, "投递确认请求非法");
  return { runId: runId.value, deliveryToken: deliveryToken.value };
}

/** 路由参数同样是外部输入：先安全解码，再转为品牌化 RunId。 */
export function parseRouteRunId(encodedRunId: string): RunId {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedRunId);
  } catch {
    throw new HttpInputError(400, "runId 非法");
  }
  const runId = parseRunId(decoded);
  if (!runId.ok) throw new HttpInputError(400, "runId 非法");
  return runId.value;
}
