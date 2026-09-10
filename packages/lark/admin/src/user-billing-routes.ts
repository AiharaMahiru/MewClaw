import type { IncomingMessage, ServerResponse } from "node:http";

import { microCreditsToUsd, type BillingService, type QuotaSnapshot, type UsageAggregate } from "dsh-lark-billing";
import { parseUserId, type Scope } from "dsh-lark-contracts";

import { HttpInputError, pathnameOf, sendError, sendJson, sendNoContent } from "./http.js";
import type { ProtectedRoute, RouteRegistrar } from "./route-types.js";

const BASE_PATH = "/api/billing";
const USER_ID_HEADER = "x-dsh-auth-user-id";
const MAX_USER_IDENTITIES = 32;

function userScope(adminScope: Scope, value: unknown): Scope {
  const parsed = parseUserId(value);
  if (!parsed.ok) throw new HttpInputError(401, "UNAUTHORIZED", "invalid authenticated user");
  return { ...adminScope, userId: parsed.value };
}

function authenticatedUserScopes(adminScope: Scope, request: IncomingMessage): Scope[] {
  const raw = request.headers[USER_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new HttpInputError(401, "UNAUTHORIZED", "missing authenticated user");
  let values: unknown = [value];
  if (value.startsWith("[")) {
    try { values = JSON.parse(value); } catch { throw new HttpInputError(401, "UNAUTHORIZED", "invalid authenticated user"); }
  }
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_USER_IDENTITIES) {
    throw new HttpInputError(401, "UNAUTHORIZED", "invalid authenticated user");
  }
  return [...new Set(values)].map((item) => userScope(adminScope, item));
}

function mergeAggregates(rows: UsageAggregate[]): UsageAggregate[] {
  const merged = new Map<string, UsageAggregate>();
  for (const row of rows) {
    const key = `${row.provider}\0${row.model}`;
    const current = merged.get(key);
    if (!current) { merged.set(key, { ...row }); continue; }
    current.calls += row.calls;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.cacheWriteTokens += row.cacheWriteTokens;
    current.reasoningTokens += row.reasoningTokens;
    current.totalMicroCredits += row.totalMicroCredits;
  }
  return [...merged.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function publicAggregate(row: UsageAggregate) {
  return {
    provider: row.provider,
    model: row.model,
    calls: row.calls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
    totalUsd: microCreditsToUsd(row.totalMicroCredits),
  };
}

function usageTotals(rows: UsageAggregate[]) {
  const totals = rows.reduce((total, row) => ({
    calls: total.calls + row.calls,
    inputTokens: total.inputTokens + row.inputTokens,
    outputTokens: total.outputTokens + row.outputTokens,
    cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + row.cacheWriteTokens,
    reasoningTokens: total.reasoningTokens + row.reasoningTokens,
    totalTokens: total.totalTokens + row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
    totalMicroCredits: total.totalMicroCredits + row.totalMicroCredits,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, totalMicroCredits: 0 });
  const { totalMicroCredits, ...publicTotals } = totals;
  return { ...publicTotals, totalUsd: microCreditsToUsd(totalMicroCredits) };
}

function publicQuota(quota: QuotaSnapshot, usedUsd: number) {
  const monthlyLimitUsd = microCreditsToUsd(quota.monthlyLimitMicroCredits);
  return {
    periodStart: quota.periodStart,
    monthlyLimitUsd,
    usedUsd,
    remainingUsd: Math.max(0, monthlyLimitUsd - usedUsd),
  };
}

async function handle(
  billing: BillingService,
  adminScope: Scope,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = pathnameOf(request).slice(BASE_PATH.length) || "/";
  if (request.method !== "GET") return sendNoContent(response, 405);
  if (path !== "/usage") return sendError(response, 404, "NOT_FOUND");
  const scopes = authenticatedUserScopes(adminScope, request);
  const quota = await billing.quota(scopes[0]!);
  const from = new Date(`${quota.periodStart}T00:00:00.000Z`);
  const rows = mergeAggregates((await Promise.all(scopes.map((scope) => billing.aggregate({
    scope, userId: scope.userId, from,
  })))).flat());
  const totals = usageTotals(rows);
  sendJson(response, 200, {
    periodStart: quota.periodStart,
    quota: publicQuota(quota, totals.totalUsd),
    totals,
    models: rows.map(publicAggregate),
  });
}

/** Auth Edge 代理的当前用户只读计费面；用户 ID 只能来自内部认证头。 */
export function registerUserBillingRoutes(
  webServer: RouteRegistrar,
  billing: BillingService,
  adminScope: Scope,
  protect: ProtectedRoute,
): () => void {
  return webServer.register({
    kind: "prefix",
    path: BASE_PATH,
    handler: (request, response) => {
      void protect(request, response, () => handle(billing, adminScope, request, response));
    },
  });
}
