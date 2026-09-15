import type {
  AdminConversationSnapshot,
  AdminDashboardSnapshot,
  AdminIdentity,
  AdminSessionSummary,
  AdminSummary,
  AdminUserSummary,
  BillingAggregate,
  BillingModelPrice,
  BillingQuota,
  IngestionRun,
  KnowledgeDocument,
  KnowledgeSnapshot,
  MemoryCube,
  MemoryEdge,
  MemoryNode,
  MemoryPart,
  MemorySource,
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

const MEMORY_VISIBILITIES = ["user_private", "project_shared", "agent_shared", "deployment_shared", "tenant_shared"] as const;
const MEMORY_NODE_KINDS = ["preference", "fact", "goal", "profile", "episode", "tool_trace", "image", "document", "other"] as const;
const MEMORY_MODALITIES = ["text", "image", "tool_trace", "persona"] as const;
const MEMORY_STATUSES = ["active", "archived"] as const;
const MEMORY_RELATIONS = ["supports", "contradicts", "derived_from", "related_to", "part_of"] as const;
const MAX_MEMORY_ITEMS = 512;
const MAX_MEMORY_TEXT = 16_384;

function parseMemoryPart(value: unknown, path: string): MemoryPart {
  const input = record(value, path);
  const modality = enumValue(input.modality, MEMORY_MODALITIES, `${path}.modality`);
  if (modality === "text") return { modality, text: stringValue(input.text, `${path}.text`, MAX_MEMORY_TEXT) };
  if (modality === "image") {
    return { modality, uri: stringValue(input.uri, `${path}.uri`, MAX_SHORT_TEXT * 8), ...(input.alt !== undefined ? { alt: optionalString(input.alt, `${path}.alt`, MAX_MEMORY_TEXT) } : {}), ...(input.sha256 !== undefined ? { sha256: optionalString(input.sha256, `${path}.sha256`, MAX_SHORT_TEXT) } : {}) };
  }
  if (modality === "persona") {
    return { modality, trait: stringValue(input.trait, `${path}.trait`, MAX_SHORT_TEXT), value: stringValue(input.value, `${path}.value`, MAX_MEMORY_TEXT), ...(input.confidence !== undefined ? { confidence: usd(input.confidence, `${path}.confidence`) } : {}) };
  }
  return { modality, tool: stringValue(input.tool, `${path}.tool`, MAX_SHORT_TEXT), ...(input.input !== undefined ? { input: input.input } : {}), ...(input.output !== undefined ? { output: input.output } : {}), ...(input.ok !== undefined ? { ok: booleanValue(input.ok, `${path}.ok`) } : {}) };
}

function parseMemorySource(value: unknown, path: string): MemorySource | undefined {
  if (value === undefined) return undefined;
  const input = record(value, path);
  return {
    kind: enumValue(input.kind, ["conversation", "feedback", "tool", "import", "system"] as const, `${path}.kind`),
    ...(input.reference !== undefined ? { reference: optionalString(input.reference, `${path}.reference`, MAX_SHORT_TEXT) } : {}),
  };
}

export function parseMemoryNode(value: unknown, path: string): MemoryNode {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, MAX_SHORT_TEXT),
    cubeId: stringValue(input.cubeId, `${path}.cubeId`, MAX_SHORT_TEXT),
    kind: enumValue(input.kind, MEMORY_NODE_KINDS, `${path}.kind`),
    parts: list(input.parts, `${path}.parts`, MAX_MEMORY_ITEMS, (item, index) => parseMemoryPart(item, `${path}.parts[${index}]`)),
    ...(input.metadata !== undefined ? { metadata: record(input.metadata, `${path}.metadata`) } : {}),
    ...(input.confidence !== undefined ? { confidence: usd(input.confidence, `${path}.confidence`) } : {}),
    ...(input.source !== undefined ? { source: parseMemorySource(input.source, `${path}.source`) } : {}),
    revision: counter(input.revision, `${path}.revision`),
    status: enumValue(input.status, MEMORY_STATUSES, `${path}.status`),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    updatedAt: stringValue(input.updatedAt, `${path}.updatedAt`, MAX_SHORT_TEXT),
  };
}

function parseMemoryEdge(value: unknown, path: string): MemoryEdge {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, MAX_SHORT_TEXT),
    cubeId: stringValue(input.cubeId, `${path}.cubeId`, MAX_SHORT_TEXT),
    fromId: stringValue(input.fromId, `${path}.fromId`, MAX_SHORT_TEXT),
    toId: stringValue(input.toId, `${path}.toId`, MAX_SHORT_TEXT),
    relation: enumValue(input.relation, MEMORY_RELATIONS, `${path}.relation`),
    ...(input.metadata !== undefined ? { metadata: record(input.metadata, `${path}.metadata`) } : {}),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
  };
}

export function parseMemoryCube(value: unknown, path: string): MemoryCube {
  const input = record(value, path);
  return {
    id: stringValue(input.id, `${path}.id`, MAX_SHORT_TEXT),
    key: stringValue(input.key, `${path}.key`, MAX_SHORT_TEXT),
    name: stringValue(input.name, `${path}.name`, MAX_SHORT_TEXT),
    visibility: enumValue(input.visibility, MEMORY_VISIBILITIES, `${path}.visibility`),
    ...(input.projectKey !== undefined ? { projectKey: optionalString(input.projectKey, `${path}.projectKey`, MAX_SHORT_TEXT) } : {}),
    ...(input.agentKey !== undefined ? { agentKey: optionalString(input.agentKey, `${path}.agentKey`, MAX_SHORT_TEXT) } : {}),
    ownerUserId: stringValue(input.ownerUserId, `${path}.ownerUserId`, MAX_SHORT_TEXT),
    revision: counter(input.revision, `${path}.revision`),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    updatedAt: stringValue(input.updatedAt, `${path}.updatedAt`, MAX_SHORT_TEXT),
  };
}

export function decodeMemoryCubeList(value: unknown): { cubes: MemoryCube[] } {
  const input = record(value, "memory.cubes");
  if (input.op !== "cube_list") invalid("memory.cubes.op");
  return { cubes: list(input.cubes, "memory.cubes.cubes", MAX_MEMORY_ITEMS, (item, index) => parseMemoryCube(item, `memory.cubes.cubes[${index}]`)) };
}

export function decodeMemoryCubeRead(value: unknown): { cube?: MemoryCube } {
  const input = record(value, "memory.cube");
  if (input.op !== "cube_read") invalid("memory.cube.op");
  return { cube: input.cube === undefined || input.cube === null ? undefined : parseMemoryCube(input.cube, "memory.cube.cube") };
}

export function decodeMemorySearch(value: unknown): { nodes: MemoryNode[]; edges: MemoryEdge[] } {
  const input = record(value, "memory.search");
  if (input.op !== "search") invalid("memory.search.op");
  return {
    nodes: list(input.nodes, "memory.search.nodes", MAX_MEMORY_ITEMS, (item, index) => parseMemoryNode(item, `memory.search.nodes[${index}]`)),
    edges: list(input.edges, "memory.search.edges", MAX_MEMORY_ITEMS, (item, index) => parseMemoryEdge(item, `memory.search.edges[${index}]`)),
  };
}

export function decodeMemoryNodeRead(value: unknown): { node?: MemoryNode; edges: MemoryEdge[] } {
  const input = record(value, "memory.read");
  if (input.op !== "read") invalid("memory.read.op");
  return {
    node: input.node === undefined || input.node === null ? undefined : parseMemoryNode(input.node, "memory.read.node"),
    edges: list(input.edges, "memory.read.edges", MAX_MEMORY_ITEMS, (item, index) => parseMemoryEdge(item, `memory.read.edges[${index}]`)),
  };
}

export function decodeMemoryMutation(value: unknown): { op: string } {
  const input = record(value, "memory.mutation");
  return { op: stringValue(input.op, "memory.mutation.op", MAX_SHORT_TEXT) };
}

function parseAdminIdentity(value: unknown, path: string): AdminIdentity {
  const input = record(value, path);
  const user = record(input.user, `${path}.user`);
  return {
    provider: enumValue(input.provider, ["feishu"] as const, `${path}.provider`),
    subject: stringValue(input.subject, `${path}.subject`, MAX_SHORT_TEXT),
    unionId: nullableString(input.unionId, `${path}.unionId`, MAX_SHORT_TEXT),
    createdAt: stringValue(input.createdAt, `${path}.createdAt`, MAX_SHORT_TEXT),
    user: {
      id: stringValue(user.id, `${path}.user.id`, MAX_SHORT_TEXT),
      email: stringValue(user.email, `${path}.user.email`, MAX_SHORT_TEXT),
      displayName: stringValue(user.displayName, `${path}.user.displayName`, MAX_SHORT_TEXT),
      role: enumValue(user.role, ADMIN_ROLES, `${path}.user.role`),
    },
  };
}

export function decodeAdminIdentities(value: unknown): { identities: AdminIdentity[] } {
  const input = record(value, "admin.identities");
  return { identities: list(input.identities, "admin.identities.identities", MAX_USERS, (item, index) => parseAdminIdentity(item, `admin.identities.identities[${index}]`)) };
}
