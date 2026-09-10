import type {
  AdminConversationSnapshot,
  AdminDashboardSnapshot,
  AdminSessionSummary,
  AdminSummary,
  AdminUserSummary,
  BillingAggregate,
  BillingModelPrice,
  BillingQuota,
  IngestionRun,
  KnowledgeDocument,
  KnowledgeSnapshot,
  SessionOverview,
} from "./api.js";

const MAX_TARGETS = 128;
const MAX_TODOS = 128;
const MAX_DOCUMENTS = 1_024;
const MAX_RUNS = 100;
const MAX_USERS = 10_000;
const MAX_SESSIONS = 20_000;
const MAX_BILLING_ROWS = 20_000;
const MAX_PRICES = 2_000;
const MAX_TAGS = 8;
const MAX_SHORT_TEXT = 256;
const MAX_TODO_TEXT = 4_096;
const MAX_COUNTER = 1_000_000_000_000;
const MAX_USD = 9_000_000_000;

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const VISIBILITIES = ["user_private", "bot_shared"] as const;
const DOCUMENT_STATUSES = ["processing", "active", "superseded", "failed", "deleted"] as const;
const CATEGORIES = ["general", "product_manual", "technical_spec", "project_document", "policy_process", "faq"] as const;
const RUN_STATUSES = ["processing", "completed", "failed"] as const;
const ADMIN_ROLES = ["admin", "user"] as const;
const ADMIN_STATUSES = ["pending", "active", "disabled"] as const;
const ADMIN_MODES = ["full", "lightweight"] as const;

function invalid(path: string): never {
  throw new Error(`invalid admin response: ${path}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) invalid(path);
  return value;
}

function optionalString(value: unknown, path: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : stringValue(value, path, maxLength);
}

function nullableString(value: unknown, path: string, maxLength: number): string | null {
  return value === null ? null : stringValue(value, path, maxLength);
}

function counter(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_COUNTER) invalid(path);
  return value as number;
}

function usd(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_USD) invalid(path);
  const normalized = Number(value.toFixed(6));
  if (Math.abs(value - normalized) > 1e-6) invalid(path);
  return normalized;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(path);
  return value as T;
}

function list<T>(value: unknown, path: string, maximum: number, parse: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(path);
  return value.map(parse);
}

function parseSession(value: unknown, path: string): SessionOverview {
  const input = record(value, path);
  if (input.exists === false) return { exists: false };
  if (input.exists !== true) invalid(`${path}.exists`);
  const todos = list(input.todos, `${path}.todos`, MAX_TODOS, (item, index) => {
    const todo = record(item, `${path}.todos[${index}]`);
    return {
      content: stringValue(todo.content, `${path}.todos[${index}].content`, MAX_TODO_TEXT),
      status: enumValue(todo.status, TODO_STATUSES, `${path}.todos[${index}].status`),
    };
  });
  const usage = record(input.usage, `${path}.usage`);
  const result: SessionOverview = {
    exists: true,
    todos,
    usage: {
      runs: counter(usage.runs, `${path}.usage.runs`),
      modelCalls: counter(usage.modelCalls, `${path}.usage.modelCalls`),
      inputTokens: counter(usage.inputTokens, `${path}.usage.inputTokens`),
      outputTokens: counter(usage.outputTokens, `${path}.usage.outputTokens`),
      cacheReadTokens: counter(usage.cacheReadTokens, `${path}.usage.cacheReadTokens`),
      cacheWriteTokens: counter(usage.cacheWriteTokens, `${path}.usage.cacheWriteTokens`),
      reasoningTokens: counter(usage.reasoningTokens, `${path}.usage.reasoningTokens`),
    },
  };
  const lastActivityAt = optionalString(input.lastActivityAt, `${path}.lastActivityAt`, MAX_SHORT_TEXT);
  if (lastActivityAt !== undefined) result.lastActivityAt = lastActivityAt;
  return result;
}

function parseConversation(value: unknown, path: string): AdminConversationSnapshot {
  const input = record(value, path);
  const target = record(input.target, `${path}.target`);
  return {
    target: {
      id: stringValue(target.id, `${path}.target.id`, MAX_SHORT_TEXT),
      label: stringValue(target.label, `${path}.target.label`, MAX_SHORT_TEXT),
    },
    generation: counter(input.generation, `${path}.generation`),
    observedAt: stringValue(input.observedAt, `${path}.observedAt`, MAX_SHORT_TEXT),
    session: parseSession(input.session, `${path}.session`),
  };
}

export function decodeDashboard(value: unknown): AdminDashboardSnapshot {
  const input = record(value, "dashboard");
  const worker = record(input.worker, "dashboard.worker");
  if (worker.ok !== true) invalid("dashboard.worker.ok");
  return {
    worker: {
      ok: true,
      queueDepth: counter(worker.queueDepth, "dashboard.worker.queueDepth"),
      observedAt: stringValue(worker.observedAt, "dashboard.worker.observedAt", MAX_SHORT_TEXT),
    },
    targets: list(input.targets, "dashboard.targets", MAX_TARGETS, (item, index) => parseConversation(item, `dashboard.targets[${index}]`)),
  };
}

export function decodeConversation(value: unknown): AdminConversationSnapshot {
  return parseConversation(value, "conversation");
}

function parseAdminUser(value: unknown, path: string): AdminUserSummary {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, MAX_SHORT_TEXT),
    email: stringValue(input.email, `${path}.email`, MAX_SHORT_TEXT),
    displayName: stringValue(input.displayName, `${path}.displayName`, MAX_SHORT_TEXT),
    role: enumValue(input.role, ADMIN_ROLES, `${path}.role`),
    status: enumValue(input.status, ADMIN_STATUSES, `${path}.status`),
    defaultMode: enumValue(input.defaultMode, ADMIN_MODES, `${path}.defaultMode`),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    updatedAt: stringValue(input.updatedAt, `${path}.updatedAt`, MAX_SHORT_TEXT),
    sessionCount: counter(input.sessionCount, `${path}.sessionCount`),
    workspaceCount: counter(input.workspaceCount, `${path}.workspaceCount`),
    identityCount: counter(input.identityCount, `${path}.identityCount`),
  };
}

function parseAdminSession(value: unknown, path: string): AdminSessionSummary {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, MAX_SHORT_TEXT),
    userId: stringValue(input.userId, `${path}.userId`, MAX_SHORT_TEXT),
    email: stringValue(input.email, `${path}.email`, MAX_SHORT_TEXT),
    displayName: stringValue(input.displayName, `${path}.displayName`, MAX_SHORT_TEXT),
    role: enumValue(input.role, ADMIN_ROLES, `${path}.role`),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    expiresAt: stringValue(input.expiresAt, `${path}.expiresAt`, MAX_SHORT_TEXT),
    lastSeenAt: stringValue(input.lastSeenAt, `${path}.lastSeenAt`, MAX_SHORT_TEXT),
    revokedAt: nullableString(input.revokedAt, `${path}.revokedAt`, MAX_SHORT_TEXT),
  };
}

export function decodeAdminUsers(value: unknown): { users: AdminUserSummary[] } {
  const input = record(value, "admin.users");
  return { users: list(input.users, "admin.users.users", MAX_USERS, (item, index) => parseAdminUser(item, `admin.users.users[${index}]`)) };
}

export function decodeAdminSessions(value: unknown): { sessions: AdminSessionSummary[] } {
  const input = record(value, "admin.sessions");
  return { sessions: list(input.sessions, "admin.sessions.sessions", MAX_SESSIONS, (item, index) => parseAdminSession(item, `admin.sessions.sessions[${index}]`)) };
}

export function decodeAdminSummary(value: unknown): AdminSummary {
  const input = record(value, "admin.summary");
  const users = record(input.users, "admin.summary.users");
  const sessions = record(input.sessions, "admin.summary.sessions");
  const resources = record(input.resources, "admin.summary.resources");
  return {
    observedAt: stringValue(input.observedAt, "admin.summary.observedAt", MAX_SHORT_TEXT),
    users: { total: counter(users.total, "admin.summary.users.total"), active: counter(users.active, "admin.summary.users.active"), admins: counter(users.admins, "admin.summary.users.admins") },
    sessions: { total: counter(sessions.total, "admin.summary.sessions.total"), active: counter(sessions.active, "admin.summary.sessions.active") },
    resources: { workspaces: counter(resources.workspaces, "admin.summary.resources.workspaces"), identities: counter(resources.identities, "admin.summary.resources.identities") },
  };
}

export function decodeAdminUserEnvelope(value: unknown): AdminUserSummary {
  return parseAdminUser(record(value, "admin.user").user, "admin.user.user");
}

export function decodeAdminUserSessionRevoke(value: unknown): { userId: string; revokedCount: number } {
  const input = record(value, "admin.user.sessions.revoke");
  return {
    userId: stringValue(input.userId, "admin.user.sessions.revoke.userId", MAX_SHORT_TEXT),
    revokedCount: counter(input.revokedCount, "admin.user.sessions.revoke.revokedCount"),
  };
}

export function decodeAdminSessionEnvelope(value: unknown): AdminSessionSummary {
  return parseAdminSession(record(value, "admin.session").session, "admin.session.session");
}

function parseBillingAggregate(value: unknown, path: string): BillingAggregate {
  const input = record(value, path);
  return {
    periodStart: stringValue(input.periodStart, `${path}.periodStart`, MAX_SHORT_TEXT),
    tenantId: stringValue(input.tenantId, `${path}.tenantId`, MAX_SHORT_TEXT),
    botId: stringValue(input.botId, `${path}.botId`, MAX_SHORT_TEXT),
    deploymentId: stringValue(input.deploymentId, `${path}.deploymentId`, MAX_SHORT_TEXT),
    userId: stringValue(input.userId, `${path}.userId`, MAX_SHORT_TEXT),
    provider: stringValue(input.provider, `${path}.provider`, MAX_SHORT_TEXT),
    model: stringValue(input.model, `${path}.model`, MAX_SHORT_TEXT),
    calls: counter(input.calls, `${path}.calls`),
    inputTokens: counter(input.inputTokens, `${path}.inputTokens`),
    outputTokens: counter(input.outputTokens, `${path}.outputTokens`),
    cacheReadTokens: counter(input.cacheReadTokens, `${path}.cacheReadTokens`),
    cacheWriteTokens: counter(input.cacheWriteTokens, `${path}.cacheWriteTokens`),
    reasoningTokens: counter(input.reasoningTokens, `${path}.reasoningTokens`),
    totalUsd: usd(input.totalUsd, `${path}.totalUsd`),
  };
}

function parseBillingPrice(value: unknown, path: string): BillingModelPrice {
  const input = record(value, path);
  return {
    provider: stringValue(input.provider, `${path}.provider`, MAX_SHORT_TEXT),
    model: stringValue(input.model, `${path}.model`, MAX_SHORT_TEXT),
    inputUsdPerMillion: usd(input.inputUsdPerMillion, `${path}.inputUsdPerMillion`),
    outputUsdPerMillion: usd(input.outputUsdPerMillion, `${path}.outputUsdPerMillion`),
    cacheReadUsdPerMillion: usd(input.cacheReadUsdPerMillion, `${path}.cacheReadUsdPerMillion`),
    cacheWriteUsdPerMillion: usd(input.cacheWriteUsdPerMillion, `${path}.cacheWriteUsdPerMillion`),
    reasoningUsdPerMillion: usd(input.reasoningUsdPerMillion, `${path}.reasoningUsdPerMillion`),
    updatedAt: stringValue(input.updatedAt, `${path}.updatedAt`, MAX_SHORT_TEXT),
  };
}

export function decodeBillingAggregate(value: unknown): { rows: BillingAggregate[] } {
  const input = record(value, "billing.summary");
  return { rows: list(input.rows, "billing.summary.rows", MAX_BILLING_ROWS, (item, index) => parseBillingAggregate(item, `billing.summary.rows[${index}]`)) };
}

export function decodeBillingPrices(value: unknown): { prices: BillingModelPrice[] } {
  const input = record(value, "billing.prices");
  return { prices: list(input.prices, "billing.prices.prices", MAX_PRICES, (item, index) => parseBillingPrice(item, `billing.prices.prices[${index}]`)) };
}

export function decodeBillingPrice(value: unknown): BillingModelPrice {
  return parseBillingPrice(value, "billing.price");
}

export function decodeBillingQuota(value: unknown): BillingQuota {
  const input = record(value, "billing.quota");
  const scope = record(input.scope, "billing.quota.scope");
  return {
    scope: {
      tenantId: stringValue(scope.tenantId, "billing.quota.scope.tenantId", MAX_SHORT_TEXT),
      botId: stringValue(scope.botId, "billing.quota.scope.botId", MAX_SHORT_TEXT),
      deploymentId: stringValue(scope.deploymentId, "billing.quota.scope.deploymentId", MAX_SHORT_TEXT),
      userId: stringValue(scope.userId, "billing.quota.scope.userId", MAX_SHORT_TEXT),
    },
    periodStart: stringValue(input.periodStart, "billing.quota.periodStart", MAX_SHORT_TEXT),
    monthlyLimitUsd: usd(input.monthlyLimitUsd, "billing.quota.monthlyLimitUsd"),
    usedUsd: usd(input.usedUsd, "billing.quota.usedUsd"),
    remainingUsd: usd(input.remainingUsd, "billing.quota.remainingUsd"),
  };
}

function parseDocument(value: unknown, path: string): KnowledgeDocument {
  const input = record(value, path);
  return {
    docId: stringValue(input.docId, `${path}.docId`, MAX_SHORT_TEXT),
    baseId: stringValue(input.baseId, `${path}.baseId`, MAX_SHORT_TEXT),
    documentKey: stringValue(input.documentKey, `${path}.documentKey`, MAX_SHORT_TEXT),
    name: stringValue(input.name, `${path}.name`, MAX_SHORT_TEXT),
    mimeType: stringValue(input.mimeType, `${path}.mimeType`, MAX_SHORT_TEXT),
    size: counter(input.size, `${path}.size`),
    sha256: stringValue(input.sha256, `${path}.sha256`, MAX_SHORT_TEXT),
    visibility: enumValue(input.visibility, VISIBILITIES, `${path}.visibility`),
    status: enumValue(input.status, DOCUMENT_STATUSES, `${path}.status`),
    version: counter(input.version, `${path}.version`),
    chunkCount: counter(input.chunkCount, `${path}.chunkCount`),
    category: enumValue(input.category, CATEGORIES, `${path}.category`),
    tags: list(input.tags, `${path}.tags`, MAX_TAGS, (item, index) => stringValue(item, `${path}.tags[${index}]`, MAX_SHORT_TEXT)),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    activatedAt: nullableString(input.activatedAt, `${path}.activatedAt`, MAX_SHORT_TEXT),
    canManage: booleanValue(input.canManage, `${path}.canManage`),
  };
}

export function decodeKnowledgeSnapshot(value: unknown): KnowledgeSnapshot {
  const input = record(value, "knowledge");
  const summary = record(input.summary, "knowledge.summary");
  return {
    documents: list(input.documents, "knowledge.documents", MAX_DOCUMENTS, (item, index) => parseDocument(item, `knowledge.documents[${index}]`)),
    summary: {
      totalVersions: counter(summary.totalVersions, "knowledge.summary.totalVersions"),
      activeDocuments: counter(summary.activeDocuments, "knowledge.summary.activeDocuments"),
      privateDocuments: counter(summary.privateDocuments, "knowledge.summary.privateDocuments"),
      sharedDocuments: counter(summary.sharedDocuments, "knowledge.summary.sharedDocuments"),
      archivedDocuments: counter(summary.archivedDocuments, "knowledge.summary.archivedDocuments"),
      totalChunks: counter(summary.totalChunks, "knowledge.summary.totalChunks"),
      totalBytes: counter(summary.totalBytes, "knowledge.summary.totalBytes"),
    },
  };
}

function parseRun(value: unknown, path: string): IngestionRun {
  const input = record(value, path);
  return {
    runId: stringValue(input.runId, `${path}.runId`, MAX_SHORT_TEXT),
    visibility: enumValue(input.visibility, VISIBILITIES, `${path}.visibility`),
    fileName: stringValue(input.fileName, `${path}.fileName`, MAX_SHORT_TEXT),
    mimeType: stringValue(input.mimeType, `${path}.mimeType`, MAX_SHORT_TEXT),
    sourceSize: counter(input.sourceSize, `${path}.sourceSize`),
    category: enumValue(input.category, CATEGORIES, `${path}.category`),
    tags: list(input.tags, `${path}.tags`, MAX_TAGS, (item, index) => stringValue(item, `${path}.tags[${index}]`, MAX_SHORT_TEXT)),
    stage: stringValue(input.stage, `${path}.stage`, MAX_SHORT_TEXT),
    progress: counter(input.progress, `${path}.progress`),
    status: enumValue(input.status, RUN_STATUSES, `${path}.status`),
    documentId: nullableString(input.documentId, `${path}.documentId`, MAX_SHORT_TEXT),
    errorCode: nullableString(input.errorCode, `${path}.errorCode`, MAX_SHORT_TEXT),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    updatedAt: stringValue(input.updatedAt, `${path}.updatedAt`, MAX_SHORT_TEXT),
    completedAt: nullableString(input.completedAt, `${path}.completedAt`, MAX_SHORT_TEXT),
  };
}

export function decodeRuns(value: unknown): { runs: IngestionRun[] } {
  const input = record(value, "runs");
  return { runs: list(input.runs, "runs.runs", MAX_RUNS, (item, index) => parseRun(item, `runs.runs[${index}]`)) };
}

export function decodeRun(value: unknown): IngestionRun {
  return parseRun(value, "run");
}

export function decodeDocument(value: unknown): KnowledgeDocument {
  return parseDocument(value, "document");
}

export const MAX_ADMIN_RUN_QUERY = MAX_RUNS;
export const DEFAULT_ADMIN_RUN_QUERY = 8;
