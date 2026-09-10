import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  fetchBillingPrices,
  fetchBillingQuota,
  fetchBillingSummary,
  fetchAdminSummary,
  fetchAdminUsers,
  fetchConversation,
  fetchDashboard,
  fetchRuns,
  getToken,
  setToken,
  revokeAdminUserSessions,
  updateAdminUser,
} from "./api.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

let session: Storage;
let legacy: Storage;

beforeEach(() => {
  session = memoryStorage();
  legacy = memoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", legacy);
});

afterEach(() => vi.unstubAllGlobals());

describe("admin-web API client", () => {
  it("migrates the legacy token once and then uses session storage", () => {
    legacy.setItem("mewclaw-admin-token", "old-token");

    expect(getToken()).toBe("old-token");
    expect(session.getItem("mewclaw-admin-token")).toBe("old-token");
    expect(legacy.getItem("mewclaw-admin-token")).toBeNull();

    setToken(" next-token ");
    expect(getToken()).toBe("next-token");
  });

  it("uses only the admin proxy and clears a token after 401", async () => {
    setToken("admin-token");
    const request = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 }));
    vi.stubGlobal("fetch", request);

    await expect(fetchDashboard()).rejects.toEqual(new ApiError(401, "UNAUTHORIZED"));
    await expect(fetchConversation("current-agent", 3)).rejects.toEqual(new ApiError(401, "UNAUTHORIZED"));

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/dashboard",
      "/api/admin/control/conversations/current-agent?generation=3",
    ]);
    expect(getToken()).toBe("");
  });

  it("rejects malformed JSON DTOs instead of passing them to React", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ worker: { ok: true } }), { status: 200 })));

    await expect(fetchDashboard()).rejects.toEqual(new ApiError(502, "INVALID_RESPONSE"));
  });

  it("validates knowledge run responses and bounds the requested page size", async () => {
    const request = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ runs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    await expect(fetchRuns(10_000)).resolves.toEqual({ runs: [] });
    expect(request.mock.calls[0]?.[0]).toBe("/api/admin/knowledge/uploads?limit=8");
  });

  it("decodes management summaries and rejects incomplete user rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(path.endsWith("users")
      ? { users: [{ id: "u1", email: "u@example.com", displayName: "User", role: "user", status: "active", defaultMode: "lightweight", createdAt: "2026-01-01", updatedAt: "2026-01-01", sessionCount: 1, workspaceCount: 2, identityCount: 0 }] }
      : { observedAt: "2026-01-01", users: { total: 1, active: 1, admins: 0 }, sessions: { total: 1, active: 1 }, resources: { workspaces: 2, identities: 0 } }), { status: 200 })));
    await expect(fetchAdminUsers()).resolves.toMatchObject({ users: [{ email: "u@example.com", workspaceCount: 2 }] });
    await expect(fetchAdminSummary()).resolves.toMatchObject({ users: { total: 1 }, resources: { workspaces: 2 } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ users: [{}] }), { status: 200 })));
    await expect(fetchAdminUsers()).rejects.toEqual(new ApiError(502, "INVALID_RESPONSE"));
  });

  it("adds the auth-edge CSRF token to admin mutations", async () => {
    vi.stubGlobal("document", { cookie: "dsh_csrf=csrf%2Bvalue" });
    const request = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ user: {
      id: "u1", email: "u@example.com", displayName: "User", role: "user", status: "disabled", defaultMode: "lightweight",
      createdAt: "2026-01-01", updatedAt: "2026-01-01", sessionCount: 0, workspaceCount: 1, identityCount: 0,
    } }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    await expect(updateAdminUser("u1", { status: "disabled" })).resolves.toMatchObject({ status: "disabled" });
    const init = request.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf+value");
  });

  it("decodes the bulk user-session revoke result", async () => {
    vi.stubGlobal("document", { cookie: "dsh_csrf=csrf-token" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ userId: "u1", revokedCount: 2 }), { status: 200 })));

    await expect(revokeAdminUserSessions("u1")).resolves.toEqual({ userId: "u1", revokedCount: 2 });
  });

  it("只接受 USD 计费 DTO，不把内部微美元暴露给页面", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path.endsWith("/quota?userId=u1")) return new Response(JSON.stringify({
        scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: "u1" },
        periodStart: "2026-08-01", monthlyLimitUsd: 10, usedUsd: 0.25, remainingUsd: 9.75,
      }), { status: 200 });
      if (path.endsWith("/prices")) return new Response(JSON.stringify({ prices: [{
        provider: "deepseek-official", model: "deepseek-v4-flash", inputUsdPerMillion: 0.22,
        outputUsdPerMillion: 0.66, cacheReadUsdPerMillion: 0.007, cacheWriteUsdPerMillion: 0,
        reasoningUsdPerMillion: 0, updatedAt: "2026-08-23T00:00:00.000Z",
      }] }), { status: 200 });
      return new Response(JSON.stringify({ rows: [{
        periodStart: "2026-08-01", tenantId: "t", botId: "b", deploymentId: "d", userId: "u1",
        provider: "deepseek-official", model: "deepseek-v4-flash", calls: 1, inputTokens: 1,
        outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalUsd: 0.000002,
      }] }), { status: 200 });
    }));
    await expect(fetchBillingQuota("u1")).resolves.toMatchObject({ monthlyLimitUsd: 10, usedUsd: 0.25 });
    await expect(fetchBillingPrices()).resolves.toMatchObject({ prices: [{ inputUsdPerMillion: 0.22 }] });
    await expect(fetchBillingSummary()).resolves.toMatchObject({ rows: [{ totalUsd: 0.000002 }] });
  });
});
