import {
  parseSessionId,
  type SessionDirectoryCurrent,
  type SessionDirectoryEntry,
  type SessionDirectoryList,
} from "dsh-lark-contracts";

import { RunClientError } from "./errors.js";

const CURRENT_DETERMINISTIC_FIELDS = new Set(["mode"]);
const CURRENT_SHARED_FIELDS = new Set(["mode", "sessionId"]);
const LIST_FIELDS = new Set(["sessions"]);
const ENTRY_FIELDS = new Set(["sessionId", "selected", "claimedAt", "lastUsedAt"]);
const MAX_SESSIONS = 100;
const MAX_TIMESTAMP_LENGTH = 64;

function fail(): never {
  throw new RunClientError("RESPONSE_SCHEMA_ERROR", "worker 会话目录响应非法");
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}

function exactFields(input: Record<string, unknown>, fields: ReadonlySet<string>): void {
  if (Object.keys(input).length !== fields.size || Object.keys(input).some((key) => !fields.has(key))) fail();
}

function timestamp(input: unknown): string {
  if (typeof input !== "string" || input.length > MAX_TIMESTAMP_LENGTH || !Number.isFinite(Date.parse(input))) fail();
  return input;
}

export function parseSessionDirectoryCurrent(input: unknown): SessionDirectoryCurrent {
  const value = record(input);
  if (value.mode === "deterministic") {
    exactFields(value, CURRENT_DETERMINISTIC_FIELDS);
    return { mode: "deterministic" };
  }
  if (value.mode !== "shared") fail();
  exactFields(value, CURRENT_SHARED_FIELDS);
  const sessionId = parseSessionId(value.sessionId);
  if (!sessionId.ok) fail();
  return { mode: "shared", sessionId: sessionId.value };
}

function parseEntry(input: unknown): SessionDirectoryEntry {
  const value = record(input);
  exactFields(value, ENTRY_FIELDS);
  const sessionId = parseSessionId(value.sessionId);
  if (!sessionId.ok || typeof value.selected !== "boolean") fail();
  return {
    sessionId: sessionId.value,
    selected: value.selected,
    claimedAt: timestamp(value.claimedAt),
    lastUsedAt: timestamp(value.lastUsedAt),
  };
}

export function parseSessionDirectoryList(input: unknown): SessionDirectoryList {
  const value = record(input);
  exactFields(value, LIST_FIELDS);
  if (!Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) fail();
  return { sessions: value.sessions.map(parseEntry) };
}
