import {
  parseDeliveryToken,
  parseRunId,
  parseScope,
  scopeEquals,
  type CronDelivery,
  type LarkErrorCode,
  type RunRequest,
  type RunStreamDone,
  type RunStreamItem,
  type SessionOverview,
} from "dsh-lark-contracts";

import { RunClientError } from "./errors.js";

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const USAGE_KEYS = [
  "runs",
  "modelCalls",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const SESSION_OVERVIEW_FALSE_FIELDS = new Set(["exists"]);
const SESSION_OVERVIEW_FIELDS = new Set(["exists", "todos", "usage", "lastActivityAt"]);
const SESSION_OVERVIEW_REQUIRED_FIELDS = new Set(["exists", "todos", "usage"]);
const TODO_FIELDS = new Set(["content", "status"]);
const CRON_DELIVERY_RESPONSE_FIELDS = new Set(["deliveries"]);
const CRON_DELIVERY_FIELDS = new Set([
  "runId", "deliveryToken", "scope", "task", "status", "scheduledFor", "finishedAt", "output", "error",
]);
const MAX_CRON_DELIVERIES = 20;
const MAX_CRON_DELIVERY_TEXT_LENGTH = 100_000;
const MAX_TODOS = 128;
const MAX_TODO_CONTENT_LENGTH = 4_096;
const MAX_ACTIVITY_TIMESTAMP_LENGTH = 64;
const MAX_USAGE_COUNT = 1_000_000_000_000;

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasExactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).length === allowed.size && hasOnlyFields(record, allowed);
}

function parseDeliveryText(input: unknown): string | undefined {
  return typeof input === "string" && input.length <= MAX_CRON_DELIVERY_TEXT_LENGTH
    ? input
    : undefined;
}

function parseDeliveryTimestamp(input: unknown): string | undefined {
  return typeof input === "string" && Number.isFinite(Date.parse(input)) ? input : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_USAGE_COUNT;
}

function hasValidUsage(record: Record<string, unknown>): boolean {
  const usage = asRecord(record.usage);
  return usage !== undefined
    && hasExactFields(usage, new Set(USAGE_KEYS))
    && USAGE_KEYS.every((key) => isCount(usage[key]));
}

function hasValidTodos(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.todos) || record.todos.length > MAX_TODOS) return false;
  return record.todos.every((todo) => {
    const item = asRecord(todo);
    return item !== undefined
      && hasExactFields(item, TODO_FIELDS)
      && typeof item.content === "string"
      && item.content.length <= MAX_TODO_CONTENT_LENGTH
      && typeof item.status === "string"
      && TODO_STATUSES.has(item.status);
  });
}

function hasValidActivityTime(record: Record<string, unknown>): boolean {
  return record.lastActivityAt === undefined
    || (typeof record.lastActivityAt === "string"
      && record.lastActivityAt.length <= MAX_ACTIVITY_TIMESTAMP_LENGTH
      && Number.isFinite(Date.parse(record.lastActivityAt)));
}

/** 校验 worker 会话概览响应，防畸形 JSON 进入命令渲染。 */
export function parseSessionOverview(input: unknown): SessionOverview {
  const record = asRecord(input);
  if (!record) throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 会话查询响应非法");
  if (record.exists === false) {
    if (!hasExactFields(record, SESSION_OVERVIEW_FALSE_FIELDS)) {
      throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 会话查询响应非法");
    }
    return { exists: false };
  }
  const hasLastActivity = Object.prototype.hasOwnProperty.call(record, "lastActivityAt");
  const fields = hasLastActivity ? SESSION_OVERVIEW_FIELDS : SESSION_OVERVIEW_REQUIRED_FIELDS;
  const valid = record.exists === true
    && hasExactFields(record, fields)
    && hasValidUsage(record)
    && hasValidTodos(record)
    && hasValidActivityTime(record);
  if (!valid) throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 会话查询响应非法");
  return input as SessionOverview;
}

function parseCronDelivery(input: unknown): CronDelivery {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, CRON_DELIVERY_FIELDS)) {
    throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker cron 投递响应非法");
  }
  const runId = parseRunId(record.runId);
  const deliveryToken = parseDeliveryToken(record.deliveryToken);
  const scope = parseScope(record.scope);
  const task = parseDeliveryText(record.task);
  const output = parseDeliveryText(record.output);
  const scheduledFor = parseDeliveryTimestamp(record.scheduledFor);
  const finishedAt = parseDeliveryTimestamp(record.finishedAt);
  const error = record.error === undefined ? undefined : parseDeliveryText(record.error);
  const status = record.status;
  if (status !== "completed" && status !== "failed") {
    throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker cron 投递响应非法");
  }
  if (!runId.ok || !deliveryToken.ok || !scope.ok || !task || output === undefined
    || !scheduledFor || !finishedAt || (record.error !== undefined && error === undefined)) {
    throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker cron 投递响应非法");
  }
  return {
    runId: runId.value,
    deliveryToken: deliveryToken.value,
    scope: scope.value,
    task,
    status,
    scheduledFor,
    finishedAt,
    output,
    ...(error === undefined ? {} : { error }),
  };
}

/** worker HTTP JSON 同样是跨进程输入，逐条校验后才交给 Gateway。 */
export function parseCronDeliveries(input: unknown): CronDelivery[] {
  const record = asRecord(input);
  if (!record || !hasOnlyFields(record, CRON_DELIVERY_RESPONSE_FIELDS)
    || !Array.isArray(record.deliveries) || record.deliveries.length > MAX_CRON_DELIVERIES) {
    throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker cron 投递响应非法");
  }
  return record.deliveries.map(parseCronDelivery);
}

function parseJsonLine(line: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(line, "utf8") > maxBytes) {
    throw new RunClientError("STREAM_SCHEMA_ERROR", `事件行超出 ${maxBytes} 字节上限`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new RunClientError("STREAM_SCHEMA_ERROR", "事件行不是合法 JSON");
  }
  const record = asRecord(parsed);
  if (!record) throw new RunClientError("STREAM_SCHEMA_ERROR", "事件行不是 JSON 对象");
  return record;
}

function parseEnvelope(record: Record<string, unknown>, request: RunRequest): RunStreamItem["envelope"] {
  const envelope = asRecord(record.envelope);
  const runId = parseRunId(envelope?.runId);
  const scope = parseScope(envelope?.scope);
  const matches = runId.ok && scope.ok
    && runId.value === request.runId
    && scopeEquals(scope.value, request.scope);
  if (!matches) throw new RunClientError("STREAM_SCHEMA_ERROR", "事件行 envelope 与提交不一致");
  return { runId: runId.value, scope: scope.value };
}

function parseOutcome(record: Record<string, unknown>, envelope: RunStreamItem["envelope"]): RunStreamDone {
  const outcome = asRecord(record.outcome);
  if (typeof outcome?.code !== "string") {
    throw new RunClientError("STREAM_SCHEMA_ERROR", "终止行 outcome 缺 code");
  }
  return {
    envelope,
    outcome: outcome.code === "OK"
      ? { code: "OK" }
      : {
          code: outcome.code as LarkErrorCode,
          message: typeof outcome.message === "string" ? outcome.message : outcome.code,
        },
  };
}

function parseEvent(record: Record<string, unknown>, envelope: RunStreamItem["envelope"]): RunStreamItem {
  const event = asRecord(record.event);
  const valid = typeof event?.type === "string"
    && typeof event.seq === "number"
    && typeof event.time === "number"
    && asRecord(event.data) !== undefined;
  if (!valid) throw new RunClientError("STREAM_SCHEMA_ERROR", "事件行 event 形状非法");
  return { event: event as RunStreamItem["event"], envelope };
}

/** 先验 envelope，再区分事件行和终止行。 */
export function parseLine(line: string, request: RunRequest, maxBytes: number): RunStreamItem | RunStreamDone {
  const record = parseJsonLine(line, maxBytes);
  const envelope = parseEnvelope(record, request);
  return "outcome" in record && !("event" in record)
    ? parseOutcome(record, envelope)
    : parseEvent(record, envelope);
}
