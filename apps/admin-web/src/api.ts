/** 管理面浏览器 API：只访问 `/api/admin/*`，不持有运行 Scope 或内部凭证。 */

import {
  decodeConversation,
  decodeAdminSessions,
  decodeAdminSummary,
  decodeAdminUserEnvelope,
  decodeAdminUserSessionRevoke,
  decodeAdminUsers,
  decodeAdminSessionEnvelope,
  decodeBillingAggregate,
  decodeBillingPrices,
  decodeBillingQuota,
  decodeBillingPrice,
  decodeDashboard,
  decodeDocument,
  decodeKnowledgeSnapshot,
  decodeRun,
  decodeRuns,
  DEFAULT_ADMIN_RUN_QUERY,
  MAX_ADMIN_RUN_QUERY,
} from "./api-validation.js";

export type KnowledgeVisibility = "user_private" | "bot_shared";
export type KnowledgeCategory =
  | "general" | "product_manual" | "technical_spec"
  | "project_document" | "policy_process" | "faq";
export type DocumentStatus = "processing" | "active" | "superseded" | "failed" | "deleted";

export interface KnowledgeDocument {
  docId: string;
  baseId: string;
  documentKey: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  visibility: KnowledgeVisibility;
  status: DocumentStatus;
  version: number;
  chunkCount: number;
  category: KnowledgeCategory;
  tags: string[];
  createdAt: string;
  activatedAt: string | null;
  canManage: boolean;
}

export interface KnowledgeSnapshot {
  documents: KnowledgeDocument[];
  summary: {
    totalVersions: number;
    activeDocuments: number;
    privateDocuments: number;
    sharedDocuments: number;
    archivedDocuments: number;
    totalChunks: number;
    totalBytes: number;
  };
}

export interface IngestionRun {
  runId: string;
  visibility: KnowledgeVisibility;
  fileName: string;
  mimeType: string;
  sourceSize: number;
  category: KnowledgeCategory;
  tags: string[];
  stage: string;
  progress: number;
  status: "processing" | "completed" | "failed";
  documentId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AdminTargetRef {
  id: string;
  label: string;
}

export interface SessionOverviewUsage {
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export type SessionOverview = { exists: false } | {
  exists: true;
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  usage: SessionOverviewUsage;
  lastActivityAt?: string;
};

export interface AdminConversationSnapshot {
  target: AdminTargetRef;
  generation: number;
  observedAt: string;
  session: SessionOverview;
}

export interface AdminDashboardSnapshot {
  worker: { ok: true; queueDepth: number; observedAt: string };
  targets: AdminConversationSnapshot[];
}

export type AdminUserStatus = "pending" | "active" | "disabled";
export type AdminRole = "admin" | "user";
export type AdminMode = "full" | "lightweight";

export interface AdminUserSummary {
  id: string;
  email: string;
  displayName: string;
  role: AdminRole;
  status: AdminUserStatus;
  defaultMode: AdminMode;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
  workspaceCount: number;
  identityCount: number;
}

export interface AdminSessionSummary {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: AdminRole;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export interface AdminSummary {
  observedAt: string;
  users: { total: number; active: number; admins: number };
  sessions: { total: number; active: number };
  resources: { workspaces: number; identities: number };
}

export interface BillingAggregate {
  periodStart: string;
  tenantId: string;
  botId: string;
  deploymentId: string;
  userId: string;
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalUsd: number;
}

export interface BillingModelPrice {
  provider: string;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  reasoningUsdPerMillion: number;
  updatedAt: string;
}

export interface BillingQuota {
  scope: { tenantId: string; botId: string; deploymentId: string; userId: string };
  periodStart: string;
  monthlyLimitUsd: number;
  usedUsd: number;
  remainingUsd: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "mewclaw-admin-token";

/** 只迁移一次旧持久化令牌，后续会话结束即消失。 */
export function getToken(): string {
  const active = sessionStorage.getItem(TOKEN_KEY);
  if (active) return active;
  const legacy = localStorage.getItem(TOKEN_KEY);
  if (!legacy) return "";
  sessionStorage.setItem(TOKEN_KEY, legacy);
  localStorage.removeItem(TOKEN_KEY);
  return legacy;
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  const value = token.trim();
  if (!value) return clearToken();
  sessionStorage.setItem(TOKEN_KEY, value);
  localStorage.removeItem(TOKEN_KEY);
}

export async function logout(): Promise<void> {
  const csrf = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("dsh_csrf="))?.slice("dsh_csrf=".length) ?? "";
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin", headers: csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {} });
}

function csrfHeader(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("dsh_csrf="))?.slice("dsh_csrf=".length);
  if (!value) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

async function apiFetch<T>(path: string, decode: (value: unknown) => T, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const method = (init?.method ?? "GET").toUpperCase();
  const csrf = csrfHeader();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && csrf && !headers.has("x-csrf-token")) headers.set("x-csrf-token", csrf);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    clearToken();
    throw new ApiError(401, "UNAUTHORIZED");
  }
  if (!response.ok) throw new ApiError(response.status, await readErrorCode(response));
  let body: unknown;
  try {
    body = await response.json();
    return decode(body);
  } catch {
    throw new ApiError(502, "INVALID_RESPONSE");
  }
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : "INTERNAL_ERROR";
  } catch {
    return "INTERNAL_ERROR";
  }
}

export function fetchDashboard(): Promise<AdminDashboardSnapshot> {
  return apiFetch("/api/admin/dashboard", decodeDashboard);
}

export function fetchConversation(targetId: string, generation: number): Promise<AdminConversationSnapshot> {
  const query = new URLSearchParams({ generation: String(generation) });
  return apiFetch(`/api/admin/control/conversations/${encodeURIComponent(targetId)}?${query}`, decodeConversation);
}

export function fetchAdminUsers(): Promise<{ users: AdminUserSummary[] }> {
  return apiFetch("/api/admin/users", decodeAdminUsers);
}

export function fetchAdminSessions(): Promise<{ sessions: AdminSessionSummary[] }> {
  return apiFetch("/api/admin/sessions", decodeAdminSessions);
}

export function fetchAdminSummary(): Promise<AdminSummary> {
  return apiFetch("/api/admin/summary", decodeAdminSummary);
}

export function updateAdminUser(userId: string, patch: { role?: AdminRole; status?: "active" | "disabled"; defaultMode?: AdminMode }): Promise<AdminUserSummary> {
  return apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, decodeAdminUserEnvelope, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function revokeAdminUserSessions(userId: string): Promise<{ userId: string; revokedCount: number }> {
  return apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, decodeAdminUserSessionRevoke, { method: "POST" });
}

export function revokeAdminSession(sessionId: string): Promise<AdminSessionSummary> {
  return apiFetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}/revoke`, decodeAdminSessionEnvelope, { method: "POST" });
}

export function fetchBillingSummary(): Promise<{ rows: BillingAggregate[] }> {
  return apiFetch("/api/admin/billing/summary", decodeBillingAggregate);
}

export function fetchBillingPrices(): Promise<{ prices: BillingModelPrice[] }> {
  return apiFetch("/api/admin/billing/prices", decodeBillingPrices);
}

export function fetchBillingQuota(userId: string): Promise<BillingQuota> {
  const query = new URLSearchParams({ userId });
  return apiFetch(`/api/admin/billing/quota?${query}`, decodeBillingQuota);
}

export function updateBillingQuota(userId: string, monthlyLimitUsd: number): Promise<BillingQuota> {
  return apiFetch("/api/admin/billing/quota", decodeBillingQuota, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, monthlyLimitUsd }),
  });
}

export function updateBillingPrice(price: BillingModelPrice): Promise<BillingModelPrice> {
  return apiFetch("/api/admin/billing/prices", decodeBillingPrice, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(price),
  });
}

export function fetchSnapshot(): Promise<KnowledgeSnapshot> {
  return apiFetch("/api/admin/knowledge", decodeKnowledgeSnapshot);
}

export function fetchRuns(limit = DEFAULT_ADMIN_RUN_QUERY): Promise<{ runs: IngestionRun[] }> {
  const normalizedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_ADMIN_RUN_QUERY
    ? limit
    : DEFAULT_ADMIN_RUN_QUERY;
  return apiFetch(`/api/admin/knowledge/uploads?limit=${normalizedLimit}`, decodeRuns);
}

export function fetchRun(runId: string): Promise<IngestionRun> {
  return apiFetch(`/api/admin/knowledge/uploads/${encodeURIComponent(runId)}`, decodeRun);
}

export function uploadDocument(
  file: File,
  visibility: KnowledgeVisibility,
  category: KnowledgeCategory,
  tags: string[],
): Promise<IngestionRun> {
  const params = new URLSearchParams({
    name: file.name,
    mime: file.type || "text/plain",
    visibility,
    category,
    tags: JSON.stringify(tags),
  });
  return apiFetch(`/api/admin/knowledge/uploads?${params}`, decodeRun, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

export type DocumentAction = "archive" | "restore" | "reindex" | "set_visibility";

export function documentAction(
  docId: string,
  action: DocumentAction,
  visibility?: KnowledgeVisibility,
): Promise<KnowledgeDocument> {
  const body: Record<string, unknown> = { action };
  if (visibility) body.visibility = visibility;
  return apiFetch(`/api/admin/knowledge/documents/${encodeURIComponent(docId)}/action`, decodeDocument, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
