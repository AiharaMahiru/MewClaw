import type { AuthService, AuthUser } from "dsh-lark-auth";
import { accessPolicy, isPathWithinReal } from "dsh-lark-auth";

import type { WebSocketClientFrameObserver, WebSocketServerFrameFilter } from "./proxy.js";

const MUX_SESSION_FRAMES = new Set([
  "session/event",
  "session/subscribed",
  "approval/requested",
  "approval/resolved",
  "question/requested",
  "question/resolved",
  "session/queue",
  "session/jobs",
  "session/projection",
]);

const HOST_SESSION_FRAMES = new Set(["host/session-added", "host/session-removed", "host/session-status", "host/agent-error"]);

/**
 * Remote mux 的外层传输帧。新版 Gateway 不再使用 server-request 信封，
 * 而是直接把每个逻辑流编码为 item/end/error；未知业务流必须原样透传。
 */
const REMOTE_MUX_TRANSPORT_FRAMES = new Set(["item", "end", "error"]);
const REMOTE_EVENT_STREAM_ENDPOINT = "$events";
const MAX_REMOTE_MUX_STREAMS = 1_024;
const MAX_CLOSED_REMOTE_MUX_STREAMS = 4_096;
const REMOTE_SCOPED_EMIT_EVENTS = new Set([
  "agent-preset/selected",
  "api-session/activity",
  "api-session/error",
  "api-session/removed",
  "api-session/status",
  "cordis/inspect-query",
  "cordis/request-run",
]);
const REMOTE_SCOPED_WATERFALL_EVENTS = new Set(["approval/request", "user-questions/request"]);

interface UserResourceAccessors {
  owns: (type: "session" | "workspace", id: string) => Promise<boolean>;
  remember: (type: "session" | "workspace", id: string, path: string | undefined) => Promise<boolean>;
  withinUserRoot: (path: string) => Promise<boolean>;
}

export interface UserRemoteMuxPolicy {
  readonly filterServerFrames: WebSocketServerFrameFilter;
  readonly observeClientFrames: WebSocketClientFrameObserver;
}

type RemoteMuxStreamState =
  | { kind: "business" }
  | { kind: "workspace" }
  | { kind: "event"; phase: "opening" | "ready" | "rejected" };

export async function createUserEventFilter(service: AuthService, user: AuthUser, roots: { user: string; admin: string }): Promise<WebSocketServerFrameFilter> {
  if (user.role === "admin") return (text) => text;
  const resources = await createUserResourceAccessors(service, user, roots);
  return async (text) => filterFrame(text, resources.owns, resources.remember);
}

/**
 * 过滤新版 Typert Remote mux。外层 item/end/error 是协议帧，不能再交给旧
 * server-request 过滤器；只有确认是 `$events` 的值时才按 Session 归属裁剪。
 * 非 `$events` 业务流即使 value 恰好是对象，也保持原样，避免工作区/模型
 * 等普通 Remote RPC 被误删。
 */
export async function createUserRemoteMuxFilter(service: AuthService, user: AuthUser, roots: { user: string; admin: string }): Promise<WebSocketServerFrameFilter> {
  return (await createUserRemoteMuxPolicy(service, user, roots)).filterServerFrames;
}

/**
 * 创建 Remote mux 的双向策略。客户端 open 帧是区分 `$events` 与普通
 * Remote 流的唯一可靠上下文；服务端下行 item 本身不携带 endpoint。
 */
export async function createUserRemoteMuxPolicy(service: AuthService, user: AuthUser, roots: { user: string; admin: string }): Promise<UserRemoteMuxPolicy> {
  if (user.role === "admin") return { filterServerFrames: (text) => text, observeClientFrames: () => undefined };
  const resources = await createUserResourceAccessors(service, user, roots);
  const streamStates = new Map<string, RemoteMuxStreamState>();
  const closedStreamIds = new Set<string>();
  return {
    filterServerFrames: async (text) => filterRemoteMuxFrame(text, resources, streamStates, closedStreamIds),
    observeClientFrames: (text) => observeRemoteMuxClientFrame(text, streamStates, closedStreamIds),
  };
}

async function createUserResourceAccessors(service: AuthService, user: AuthUser, roots: { user: string; admin: string }): Promise<UserResourceAccessors> {
  const policy = accessPolicy(user, roots);
  const sessions = new Set((await service.listResources(user.id, "session")).map((resource) => resource.resourceId));
  const workspaces = new Set((await service.listResources(user.id, "workspace")).map((resource) => resource.resourceId));
  const withinUserRoot = (path: string): Promise<boolean> => isPathWithinReal(policy.workspaceRoot, path);
  const owns = async (type: "session" | "workspace", id: string): Promise<boolean> => {
    const known = type === "session" ? sessions : workspaces;
    if (known.has(id)) return true;
    const resource = await service.findResource(type, id);
    if (resource?.userId !== user.id) return false;
    known.add(id);
    return true;
  };
  const remember = async (type: "session" | "workspace", id: string, path: string | undefined): Promise<boolean> => {
    if (!path || !(await withinUserRoot(path))) return false;
    const known = type === "session" ? sessions : workspaces;
    if (known.has(id)) return true;
    const existing = await service.findResource(type, id);
    if (existing && existing.userId !== user.id) return false;
    known.add(id);
    await service.saveResource({ resourceType: type, resourceId: id, userId: user.id, resourcePath: path, createdAt: new Date().toISOString() });
    return true;
  };
  return { owns, remember, withinUserRoot };
}

async function filterFrame(
  text: string,
  owns: (type: "session" | "workspace", id: string) => Promise<boolean>,
  remember: (type: "session" | "workspace", id: string, path: string | undefined) => Promise<boolean>,
): Promise<string | null> {
  const envelope = parseEnvelope(text);
  const frame = parseRecord(envelope?.payload);
  const type = stringValue(frame?.type);
  if (!envelope || !frame || !type) return null;
  if (type === "stream/error") return rewritePayload(text, { type, error: { code: "internal", message: "stream unavailable", details: {} } });
  if (type === "host/remote-event") return null;
  if (MUX_SESSION_FRAMES.has(type)) return await sessionFrame(text, frame, owns, "sessionId");
  if (HOST_SESSION_FRAMES.has(type)) {
    const sessionId = stringValue(frame.sessionId);
    if (!sessionId) return null;
    if (type === "host/session-added" && await remember("session", sessionId, stringValue(frame.cwd))) return await sanitizeSessionAdded(text, frame, owns);
    return await sessionFrame(text, frame, owns, "sessionId");
  }
  if (type === "host/workspace-changed") return await workspaceChanged(text, frame, owns, remember);
  if (type === "host/workspace-removed") return await idFrame(text, frame.workspaceId, owns, "workspace");
  if (type === "host/workspace-order-changed") return await filteredListFrame(text, frame, "workspaceIds", owns, "workspace");
  if (type === "host/archived-sessions-changed") return await filteredListFrame(text, frame, "archivedSessionIds", owns, "session");
  return null;
}

async function filterRemoteMuxFrame(
  text: string,
  resources: UserResourceAccessors,
  streamStates: Map<string, RemoteMuxStreamState>,
  closedStreamIds: Set<string>,
): Promise<string | null> {
  const frame = parseRecordJson(text);
  const transportType = stringValue(frame?.type);
  const streamId = stringValue(frame?.streamId);
  if (!frame || !transportType || !streamId || !REMOTE_MUX_TRANSPORT_FRAMES.has(transportType)) return null;
  if (closedStreamIds.has(streamId)) return null;
  const state = streamStates.get(streamId);
  if (!state) return null;
  if (transportType === "end" || transportType === "error") {
    streamStates.delete(streamId);
    rememberClosedStream(streamId, closedStreamIds);
    return text;
  }
  if (!Object.hasOwn(frame, "value")) {
    if (state.kind === "event") state.phase = "rejected";
    return state.kind === "business" ? text : null;
  }

  const value = parseRecord(frame.value);
  if (state.kind === "business") return text;
  if (state.kind === "workspace") return value ? await filterWorkspaceFollowFrame(text, value, resources) : null;
  if (state.phase === "rejected") return null;
  if (state.phase === "opening") {
    if (!value || !isRemoteEventReady(value)) {
      state.phase = "rejected";
      return null;
    }
    state.phase = "ready";
    return text;
  }
  if (!value || !isRemoteEventValue(value)) return null;
  const filtered = await filterRemoteEventValue(value, resources);
  if (filtered === null) return null;
  if (filtered === value) return text;
  return JSON.stringify({ ...frame, value: filtered });
}

function observeRemoteMuxClientFrame(text: string, streamStates: Map<string, RemoteMuxStreamState>, closedStreamIds: Set<string>): void {
  const frame = parseRecordJson(text);
  const type = stringValue(frame?.type);
  const streamId = stringValue(frame?.streamId);
  if (!frame || !type || !streamId) return;
  if (type === "cancel") {
    streamStates.delete(streamId);
    rememberClosedStream(streamId, closedStreamIds);
    return;
  }
  if (type !== "open") return;
  const endpoint = stringValue(frame.endpoint);
  if (!endpoint) return;
  if (streamStates.has(streamId) || closedStreamIds.has(streamId)) throw new Error("duplicate Remote mux stream id");
  if (streamStates.size >= MAX_REMOTE_MUX_STREAMS) throw new Error("Remote mux stream limit exceeded");
  streamStates.set(streamId,
    endpoint === REMOTE_EVENT_STREAM_ENDPOINT
      ? { kind: "event", phase: "opening" }
      : endpoint === "workspace/follow"
        ? { kind: "workspace" }
        : { kind: "business" });
}

async function filterWorkspaceFollowFrame(text: string, value: Record<string, unknown>, resources: UserResourceAccessors): Promise<string | null> {
  const type = stringValue(value.type);
  if (type === "baseline") {
    const baseline = parseRecord(value.value);
    if (!baseline || !Array.isArray(baseline.items)) return null;
    const items: unknown[] = [];
    for (const item of baseline.items) {
      const workspace = parseRecord(item);
      const id = stringValue(workspace?.workspaceId);
      const path = stringValue(workspace?.path);
      if (!id || (!await resources.owns("workspace", id) && !(path && await resources.remember("workspace", id, path)))) continue;
      const sessionIds = Array.isArray(workspace?.sessionIds)
        ? (await filterOwnedSessionIds(workspace.sessionIds, resources))
        : [];
      items.push({ ...workspace, sessionIds });
    }
    const archivedSessionIds = Array.isArray(baseline.archivedSessionIds)
      ? await filterOwnedSessionIds(baseline.archivedSessionIds, resources)
      : [];
    return JSON.stringify({ ...parseRecordJson(text), value: { ...value, value: { ...baseline, items, archivedSessionIds } } });
  }
  if (type === "upsert") {
    const workspace = parseRecord(value.workspace);
    const id = stringValue(workspace?.workspaceId);
    const path = stringValue(workspace?.path);
    if (!id || (!await resources.owns("workspace", id) && !(path && await resources.remember("workspace", id, path)))) return null;
    const sessionIds = Array.isArray(workspace?.sessionIds) ? await filterOwnedSessionIds(workspace.sessionIds, resources) : [];
    return JSON.stringify({ ...parseRecordJson(text), value: { ...value, workspace: { ...workspace, sessionIds } } });
  }
  if (type === "archived" || type === "order") {
    const field = type === "archived" ? "archivedSessionIds" : "workspaceIds";
    const ids = value[field];
    if (!Array.isArray(ids)) return null;
    const filtered = type === "archived" ? await filterOwnedSessionIds(ids, resources) : await filterOwnedWorkspaceIds(ids, resources);
    return JSON.stringify({ ...parseRecordJson(text), value: { ...value, [field]: filtered } });
  }
  return null;
}

async function filterOwnedSessionIds(values: unknown[], resources: UserResourceAccessors): Promise<string[]> {
  const output: string[] = [];
  for (const value of values) if (typeof value === "string" && await resources.owns("session", value)) output.push(value);
  return output;
}

async function filterOwnedWorkspaceIds(values: unknown[], resources: UserResourceAccessors): Promise<string[]> {
  const output: string[] = [];
  for (const value of values) if (typeof value === "string" && await resources.owns("workspace", value)) output.push(value);
  return output;
}

function rememberClosedStream(streamId: string, closedStreamIds: Set<string>): void {
  closedStreamIds.delete(streamId);
  closedStreamIds.add(streamId);
  while (closedStreamIds.size > MAX_CLOSED_REMOTE_MUX_STREAMS) {
    const oldest = closedStreamIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    closedStreamIds.delete(oldest);
  }
}

function isRemoteEventReady(value: Record<string, unknown>): boolean {
  const host = parseRecord(value.host);
  return hasExactKeys(value, ["type", "clientId", "host"])
    && value.type === "ready"
    && Boolean(stringValue(value.clientId))
    && hasExactKeys(host, ["home"])
    && typeof host?.home === "string";
}

function isRemoteEventValue(value: Record<string, unknown>): boolean {
  const type = stringValue(value.type);
  if (!type) return false;
  if (type === "cancel") return hasExactKeys(value, ["type", "eventId"]) && Boolean(stringValue(value.eventId));
  if (type === "emit") return hasExactKeys(value, ["type", "event", "args"])
    && Boolean(stringValue(value.event))
    && Array.isArray(value.args);
  if (type === "waterfall") {
    const request = parseRecord(value.request);
    return hasExactKeys(value, ["type", "event", "eventId", "agentId", "request"])
      && Boolean(stringValue(value.event))
      && Boolean(stringValue(value.eventId))
      && Boolean(stringValue(value.agentId))
      && Boolean(request)
      && !Object.hasOwn(request!, "agent")
      && !Object.hasOwn(request!, "signal");
  }
  return false;
}

async function filterRemoteEventValue(value: Record<string, unknown>, resources: UserResourceAccessors): Promise<Record<string, unknown> | null> {
  const type = stringValue(value.type);
  if (!type) return value;
  if (type === "ready") {
    // ready 是 generation 建立的必要握手，必须原样放行。
    return value;
  }
  if (type === "cancel") return value;
  if (type === "waterfall") {
    const event = stringValue(value.event);
    const agentId = stringValue(value.agentId);
    if (!event || !agentId || !REMOTE_SCOPED_WATERFALL_EVENTS.has(event)) return value;
    return await resources.owns("session", agentId) ? value : null;
  }
  if (type !== "emit") return value;
  const event = stringValue(value.event);
  const args = value.args;
  if (!event || !Array.isArray(args)) return value;
  if (event === "api-session/added") {
    const summary = parseRecord(args[0]);
    const sessionId = stringValue(summary?.sessionId);
    if (!sessionId) return null;
    const cwd = stringValue(summary?.cwd);
    if (cwd && !(await resources.withinUserRoot(cwd))) return null;
    if (await resources.owns("session", sessionId)) return value;
    return cwd && await resources.remember("session", sessionId, cwd) ? value : null;
  }
  if (!REMOTE_SCOPED_EMIT_EVENTS.has(event)) return value;
  const sessionId = remoteEmitSessionId(event, args);
  return sessionId && await resources.owns("session", sessionId) ? value : null;
}

function remoteEmitSessionId(event: string, args: unknown[]): string | undefined {
  if (event === "cordis/inspect-query" || event === "cordis/request-run") return stringValue(parseRecord(args[0])?.agentId);
  return stringValue(args[0]);
}

async function sessionFrame(text: string, frame: Record<string, unknown>, owns: (type: "session" | "workspace", id: string) => Promise<boolean>, field: string): Promise<string | null> {
  const id = stringValue(frame[field]);
  return id && await owns("session", id) ? text : null;
}

async function idFrame(text: string, value: unknown, owns: (type: "session" | "workspace", id: string) => Promise<boolean>, type: "session" | "workspace"): Promise<string | null> {
  const id = stringValue(value);
  return id && await owns(type, id) ? text : null;
}

async function sanitizeSessionAdded(text: string, frame: Record<string, unknown>, owns: (type: "session" | "workspace", id: string) => Promise<boolean>): Promise<string> {
  const parentSessionId = stringValue(frame.parentSessionId);
  if (!parentSessionId || await owns("session", parentSessionId)) return text;
  const sanitized = { ...frame };
  delete sanitized.parentSessionId;
  return rewritePayload(text, sanitized) ?? text;
}

async function workspaceChanged(text: string, frame: Record<string, unknown>, owns: (type: "session" | "workspace", id: string) => Promise<boolean>, remember: (type: "session" | "workspace", id: string, path: string | undefined) => Promise<boolean>): Promise<string | null> {
  const workspace = parseRecord(frame.workspace);
  const id = stringValue(workspace?.workspaceId);
  const path = stringValue(workspace?.path);
  if (!id || (!await owns("workspace", id) && !(path && await remember("workspace", id, path)))) return null;
  const sessionIds = workspace?.sessionIds;
  if (!Array.isArray(sessionIds)) return null;
  const filtered: string[] = [];
  for (const sessionId of sessionIds) if (typeof sessionId === "string" && await owns("session", sessionId)) filtered.push(sessionId);
  if (filtered.length === sessionIds.length) return text;
  return rewritePayload(text, { ...frame, workspace: { ...workspace, sessionIds: filtered } });
}

async function filteredListFrame(text: string, frame: Record<string, unknown>, field: string, owns: (type: "session" | "workspace", id: string) => Promise<boolean>, type: "session" | "workspace"): Promise<string | null> {
  const values = frame[field];
  if (!Array.isArray(values)) return null;
  const filtered: string[] = [];
  for (const value of values) if (typeof value === "string" && await owns(type, value)) filtered.push(value);
  if (filtered.length === 0) return null;
  if (filtered.length === values.length) return text;
  return rewritePayload(text, { ...frame, [field]: filtered });
}

function rewritePayload(text: string, payload: Record<string, unknown>): string | null {
  const envelope = parseEnvelope(text);
  return envelope ? JSON.stringify({ ...envelope, payload }) : null;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function parseEnvelope(text: string): Record<string, unknown> | undefined { try { return parseRecord(JSON.parse(text)); } catch { return undefined; } }
function parseRecordJson(text: string): Record<string, unknown> | undefined { try { return parseRecord(JSON.parse(text)); } catch { return undefined; } }
function hasExactKeys(value: Record<string, unknown> | undefined, keys: readonly string[]): boolean { return value !== undefined && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
