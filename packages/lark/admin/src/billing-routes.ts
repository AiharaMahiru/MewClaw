import type { IncomingMessage, ServerResponse } from "node:http";

import {
  microCreditsToUsd,
  usdToMicroCredits,
  type BillingService,
  type ModelPrice,
  type QuotaSnapshot,
} from "dsh-lark-billing";
import { parseUserId, type Scope } from "dsh-lark-contracts";

import { HttpInputError, pathnameOf, queryParams, readJsonBody, sendError, sendJson, sendNoContent } from "./http.js";
import type { ProtectedRoute, RouteRegistrar } from "./route-types.js";

const BASE_PATH = "/api/admin/billing";
const MAX_BODY_BYTES = 16 * 1024;

function userScope(adminScope: Scope, value: unknown): Scope {
  const parsed = parseUserId(value);
  if (!parsed.ok) throw new HttpInputError(400, "INVALID_REQUEST", "invalid userId");
  return { ...adminScope, userId: parsed.value };
}

function dateQuery(value: string | null, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new HttpInputError(400, "INVALID_REQUEST", `invalid ${label}`);
  return date;
}

function queryUserScope(adminScope: Scope, request: IncomingMessage): Scope {
  return userScope(adminScope, queryParams(request).get("userId") ?? adminScope.userId);
}

function nonNegativeUsd(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HttpInputError(400, "INVALID_REQUEST", `invalid ${label}`);
  }
  try {
    return usdToMicroCredits(value, label);
  } catch {
    throw new HttpInputError(400, "INVALID_REQUEST", `invalid ${label}`);
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpInputError(400, "INVALID_REQUEST", `invalid ${label}`);
  }
  return value.trim();
}

function publicQuota(quota: QuotaSnapshot) {
  return {
    scope: quota.scope,
    periodStart: quota.periodStart,
    monthlyLimitUsd: microCreditsToUsd(quota.monthlyLimitMicroCredits),
    usedUsd: microCreditsToUsd(quota.usedMicroCredits),
    remainingUsd: microCreditsToUsd(quota.remainingMicroCredits),
  };
}

function publicPrice(price: ModelPrice) {
  return {
    provider: price.provider,
    model: price.model,
    inputUsdPerMillion: microCreditsToUsd(price.inputMicroCreditsPerMillion),
    outputUsdPerMillion: microCreditsToUsd(price.outputMicroCreditsPerMillion),
    cacheReadUsdPerMillion: microCreditsToUsd(price.cacheReadMicroCreditsPerMillion),
    cacheWriteUsdPerMillion: microCreditsToUsd(price.cacheWriteMicroCreditsPerMillion),
    reasoningUsdPerMillion: 0,
    updatedAt: price.updatedAt,
  };
}

function publicAggregate(row: Awaited<ReturnType<BillingService["aggregate"]>>[number]) {
  const { totalMicroCredits, ...publicRow } = row;
  return { ...publicRow, totalUsd: microCreditsToUsd(totalMicroCredits) };
}

async function handle(
  billing: BillingService,
  adminScope: Scope,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = pathnameOf(request).slice(BASE_PATH.length) || "/";
  if (request.method === "GET" && path === "/summary") {
    const params = queryParams(request);
    const from = dateQuery(params.get("from"), "from");
    const to = dateQuery(params.get("to"), "to");
    const userId = params.get("userId") ?? undefined;
    if (userId) userScope(adminScope, userId);
    const rows = await billing.aggregate({
      scope: adminScope,
      ...(userId ? { userId } : {}),
      ...(params.get("provider") ? { provider: params.get("provider")! } : {}),
      ...(params.get("model") ? { model: params.get("model")! } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    sendJson(response, 200, { rows: rows.map(publicAggregate) });
    return;
  }
  if (request.method === "GET" && path === "/quota") {
    sendJson(response, 200, publicQuota(await billing.quota(queryUserScope(adminScope, request))));
    return;
  }
  if (request.method === "PUT" && path === "/quota") {
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    if (Object.keys(body).some((key) => !["userId", "monthlyLimitUsd"].includes(key))) {
      throw new HttpInputError(400, "INVALID_REQUEST", "unknown quota field");
    }
    sendJson(response, 200, publicQuota(await billing.setQuota(
      userScope(adminScope, body.userId),
      nonNegativeUsd(body.monthlyLimitUsd, "monthlyLimitUsd"),
    )));
    return;
  }
  if (request.method === "GET" && path === "/prices") {
    sendJson(response, 200, { prices: (await billing.listPrices()).map(publicPrice) });
    return;
  }
  if (request.method === "PUT" && path === "/prices") {
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const fields = ["provider", "model", "inputUsdPerMillion", "outputUsdPerMillion", "cacheReadUsdPerMillion", "cacheWriteUsdPerMillion", "reasoningUsdPerMillion"];
    if (Object.keys(body).some((key) => !fields.includes(key)) || fields.some((key) => !(key in body))) {
      throw new HttpInputError(400, "INVALID_REQUEST", "invalid price fields");
    }
    const provider = nonEmptyString(body.provider, "provider");
    const model = nonEmptyString(body.model, "model");
    sendJson(response, 200, await billing.setPrice({
      provider,
      model,
      inputMicroCreditsPerMillion: nonNegativeUsd(body.inputUsdPerMillion, "input USD price"),
      outputMicroCreditsPerMillion: nonNegativeUsd(body.outputUsdPerMillion, "output USD price"),
      cacheReadMicroCreditsPerMillion: nonNegativeUsd(body.cacheReadUsdPerMillion, "cache read USD price"),
      cacheWriteMicroCreditsPerMillion: nonNegativeUsd(body.cacheWriteUsdPerMillion, "cache write USD price"),
      reasoningMicroCreditsPerMillion: 0,
      updatedAt: new Date().toISOString(),
    }).then(publicPrice));
    return;
  }
  if (request.method !== "GET" && request.method !== "PUT") return sendNoContent(response, 405);
  sendError(response, 404, "NOT_FOUND");
}

export function registerBillingRoutes(
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
