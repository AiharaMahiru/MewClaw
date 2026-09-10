import { URL } from "node:url";

import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
import {
  parseScope,
  type Scope,
  type SessionOverview,
  type SessionOverviewUsage,
} from "dsh-lark-contracts";

import { WorkerResponseError, readWorkerJson } from "./worker-response.js";

const MAX_TARGETS = 16;
const MAX_TARGET_ID_LENGTH = 48;
const MAX_LABEL_LENGTH = 80;
const MAX_GENERATION = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
const TARGET_ID = /^[a-z][a-z0-9-]*$/;
const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const MAX_TODOS = 128;
const MAX_TODO_CONTENT_LENGTH = 4_096;
const MAX_ACTIVITY_TIMESTAMP_LENGTH = 64;

export interface ControlTargetConfig {
  id: string;
  label: string;
  scope: {
    tenantId: string;
    botId: string;
    deploymentId: string;
    userId: string;
    conversationId: string;
  };
  defaultGeneration?: number;
}

export interface ControlPlaneConfig {
  workerBaseUrl: string;
  workerTokenEnv: string;
  requestTimeoutMs?: number;
  targets: ControlTargetConfig[];
}

export interface AdminTargetRef {
  id: string;
  label: string;
}

export interface AdminConversationSnapshot {
  target: AdminTargetRef;
  generation: number;
  observedAt: string;
  session: SessionOverview;
}

export interface AdminWorkerHealth {
  ok: true;
  queueDepth: number;
  observedAt: string;
}

export interface AdminDashboardSnapshot {
  worker: AdminWorkerHealth;
  targets: AdminConversationSnapshot[];
}

export interface AdminControlPlane {
  dashboard(): Promise<AdminDashboardSnapshot>;
  conversation(targetId: string, generation: number): Promise<AdminConversationSnapshot>;
}

export interface CredentialResolver {
  resolve(reference: CredentialRef): Promise<{ value?: string } | undefined>;
}

export type WorkerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ControlPlaneError";
  }
}

interface ResolvedTarget extends AdminTargetRef {
  scope: Scope;
  defaultGeneration: number;
}

interface ResolvedConfig {
  workerBaseUrl: string;
  requestTimeoutMs: number;
  targets: ResolvedTarget[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_GENERATION;
}

export function isControlTargetId(value: string): boolean {
  return TARGET_ID.test(value) && value.length <= MAX_TARGET_ID_LENGTH;
}

export function parseControlGeneration(value: string | null): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) throw new ControlPlaneError(400, "INVALID_REQUEST");
  const generation = Number(value);
  if (!validGeneration(generation)) throw new ControlPlaneError(400, "INVALID_REQUEST");
  return generation;
}

function normalizeWorkerBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("lark-admin: controlPlane.workerBaseUrl 非法");
  }
  const port = Number(url.port);
  const valid = url.protocol === "http:" && url.hostname === "127.0.0.1"
    && Number.isSafeInteger(port) && port > 0 && port <= 65_535
    && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
  if (!valid) throw new Error("lark-admin: controlPlane.workerBaseUrl 必须是 loopback origin");
  return url.origin;
}

function normalizeTarget(value: ControlTargetConfig): ResolvedTarget {
  const id = value.id.trim();
  const label = value.label.trim();
  const validId = isControlTargetId(id);
  if (!validId || !label || label.length > MAX_LABEL_LENGTH) {
    throw new Error("lark-admin: controlPlane target id 或 label 非法");
  }
  const scope = parseScope(value.scope);
  if (!scope.ok) throw new Error("lark-admin: controlPlane target Scope 非法");
  const generation = value.defaultGeneration ?? 0;
  if (!validGeneration(generation)) throw new Error("lark-admin: controlPlane defaultGeneration 非法");
  return { id, label, scope: scope.value, defaultGeneration: generation };
}

function normalizeConfig(config: ControlPlaneConfig): ResolvedConfig {
  if (!Array.isArray(config.targets) || !config.targets.length || config.targets.length > MAX_TARGETS) {
    throw new Error("lark-admin: controlPlane.targets 数量非法");
  }
  const targets = config.targets.map(normalizeTarget);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    throw new Error("lark-admin: controlPlane target id 重复");
  }
  const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const validTimeout = Number.isSafeInteger(timeout)
    && timeout >= MIN_REQUEST_TIMEOUT_MS && timeout <= MAX_REQUEST_TIMEOUT_MS;
  if (!validTimeout) throw new Error("lark-admin: controlPlane requestTimeoutMs 非法");
  return { workerBaseUrl: normalizeWorkerBaseUrl(config.workerBaseUrl), requestTimeoutMs: timeout, targets };
}

function parseHealth(value: unknown): AdminWorkerHealth {
  if (!isRecord(value) || !exactKeys(value, ["ok", "queueDepth"])) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  const queueDepth = value.queueDepth;
  if (value.ok !== true || typeof queueDepth !== "number" || !Number.isSafeInteger(queueDepth) || queueDepth < 0) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  return { ok: true, queueDepth, observedAt: new Date().toISOString() };
}

function readCounter(value: Record<string, unknown>, key: string): number {
  const counter = value[key];
  if (typeof counter !== "number" || !Number.isSafeInteger(counter) || counter < 0) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  return counter;
}

function parseUsage(value: unknown): SessionOverviewUsage {
  const keys = ["runs", "modelCalls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
  if (!isRecord(value) || !exactKeys(value, keys)) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  return {
    runs: readCounter(value, "runs"),
    modelCalls: readCounter(value, "modelCalls"),
    inputTokens: readCounter(value, "inputTokens"),
    outputTokens: readCounter(value, "outputTokens"),
    cacheReadTokens: readCounter(value, "cacheReadTokens"),
    cacheWriteTokens: readCounter(value, "cacheWriteTokens"),
    reasoningTokens: readCounter(value, "reasoningTokens"),
  };
}

function parseTodos(value: unknown): Extract<SessionOverview, { exists: true }>["todos"] {
  if (!Array.isArray(value) || value.length > MAX_TODOS) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  const todos: Extract<SessionOverview, { exists: true }>["todos"] = [];
  for (const todo of value) {
    if (!isRecord(todo) || !exactKeys(todo, ["content", "status"]) || typeof todo.content !== "string"
      || todo.content.length > MAX_TODO_CONTENT_LENGTH || !TODO_STATUSES.has(String(todo.status))) {
      throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
    }
    todos.push({ content: todo.content, status: todo.status as (typeof todos)[number]["status"] });
  }
  return todos;
}

function parseOverview(value: unknown): SessionOverview {
  if (!isRecord(value)) throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  if (value.exists === false && exactKeys(value, ["exists"])) return { exists: false };
  const lastActivityAt = value.lastActivityAt;
  const keys = lastActivityAt === undefined
    ? ["exists", "todos", "usage"]
    : ["exists", "todos", "usage", "lastActivityAt"];
  if (value.exists !== true || !exactKeys(value, keys)
    || (lastActivityAt !== undefined && (typeof lastActivityAt !== "string"
      || lastActivityAt.length > MAX_ACTIVITY_TIMESTAMP_LENGTH || !Number.isFinite(Date.parse(lastActivityAt))))) {
    throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
  }
  return {
    exists: true,
    todos: parseTodos(value.todos),
    usage: parseUsage(value.usage),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
  };
}

class WorkerControlPlane implements AdminControlPlane {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly workerToken: string,
    private readonly request: WorkerFetch,
  ) {}

  async dashboard(): Promise<AdminDashboardSnapshot> {
    const worker = parseHealth(await this.requestJson("/healthz", { method: "GET" }));
    const targets = await Promise.all(this.config.targets.map((target) => this.snapshot(target, target.defaultGeneration)));
    return { worker, targets };
  }

  async conversation(targetId: string, generation: number): Promise<AdminConversationSnapshot> {
    if (!validGeneration(generation)) throw new ControlPlaneError(400, "INVALID_REQUEST");
    const target = this.config.targets.find((item) => item.id === targetId);
    if (!target) throw new ControlPlaneError(404, "TARGET_NOT_FOUND");
    return this.snapshot(target, generation);
  }

  private async snapshot(target: ResolvedTarget, generation: number): Promise<AdminConversationSnapshot> {
    const body = JSON.stringify({ scope: target.scope, sessionGeneration: generation });
    const session = parseOverview(await this.requestJson("/v1/session-overview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    return { target: { id: target.id, label: target.label }, generation, observedAt: new Date().toISOString(), session };
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${this.workerToken}`);
      const response = await this.request(`${this.config.workerBaseUrl}${path}`, { ...init, headers, signal: controller.signal });
      if (!response.ok) throw new ControlPlaneError(503, "WORKER_UNAVAILABLE");
      return await readWorkerJson(response);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      if (error instanceof WorkerResponseError) {
        throw new ControlPlaneError(502, "WORKER_INVALID_RESPONSE");
      }
      throw new ControlPlaneError(503, "WORKER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function createControlPlane(
  config: ControlPlaneConfig,
  credentials: CredentialResolver,
  request: WorkerFetch = globalThis.fetch,
): Promise<AdminControlPlane> {
  const resolved = normalizeConfig(config);
  const credential = await credentials.resolve(config.workerTokenEnv as CredentialRef);
  if (!credential?.value) throw new Error(`lark-admin: 凭证引用未配置（${config.workerTokenEnv}）`);
  return new WorkerControlPlane(resolved, credential.value, request);
}
