import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  addBillingCredit,
  fetchAdminIdentities,
  fetchBillingPrices,
  fetchBillingQuota,
  fetchBillingSummary,
  fetchAdminSummary,
  fetchAdminUsers,
  fetchConversation,
  fetchDashboard,
  fetchMemoryCubes,
  fetchMemoryNode,
  fetchRuns,
  getToken,
  searchMemory,
  setToken,
  revokeAdminUserSessions,
  unlinkAdminIdentity,
  updateAdminUser,
  updateMemoryCube,
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

  it("decodes memory cube lists and rejects wrong ops", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ op: "cube_list", cubes: [{
      id: "c1", key: "default", name: "主记忆", visibility: "user_private", ownerUserId: "u1",
      revision: 3, createdAt: "2026-09-01", updatedAt: "2026-09-02",
    }] }), { status: 200 })));
    await expect(fetchMemoryCubes()).resolves.toEqual({ cubes: [expect.objectContaining({ key: "default", visibility: "user_private" })] });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ op: "read", cubes: [] }), { status: 200 })));
    await expect(fetchMemoryCubes()).rejects.toEqual(new ApiError(502, "INVALID_RESPONSE"));
  });

  it("sends search queries and cube patches to the memory proxy", async () => {
    vi.stubGlobal("document", { cookie: "dsh_csrf=csrf-token" });
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const path = String(args[0]);
      if (path.includes("/search")) return new Response(JSON.stringify({ op: "search", nodes: [{
        id: "n1", cubeId: "c1", kind: "preference", parts: [{ modality: "text", text: "喜欢简洁回复" }],
        revision: 1, status: "active", createdAt: "2026-09-01", updatedAt: "2026-09-01",
      }], edges: [] }), { status: 200 });
      return new Response(JSON.stringify({ op: "cube_updated" }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    await expect(searchMemory("简洁")).resolves.toMatchObject({ nodes: [{ kind: "preference" }] });
    expect(String(request.mock.calls[0]?.[0])).toBe("/api/admin/memory/search?q=%E7%AE%80%E6%B4%81");
    await expect(updateMemoryCube("c1", { name: "改名" }, 3)).resolves.toEqual({ op: "cube_updated" });
    const patchCall = request.mock.calls[1];
    expect(patchCall?.[0]).toBe("/api/admin/memory/cubes/c1");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ patch: { name: "改名" }, expectedRevision: 3 });
  });

  it("reads a memory node and validates the node shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ op: "read", node: {
      id: "n1", cubeId: "c1", kind: "fact", parts: [{ modality: "text", text: "事实" }],
      revision: 2, status: "active", createdAt: "2026-09-01", updatedAt: "2026-09-02",
    }, edges: [] }), { status: 200 })));
    await expect(fetchMemoryNode("n1")).resolves.toMatchObject({ node: { id: "n1", kind: "fact" } });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ op: "read", node: { id: "n1" }, edges: [] }), { status: 200 })));
    await expect(fetchMemoryNode("n1")).rejects.toEqual(new ApiError(502, "INVALID_RESPONSE"));
  });

  it("decodes admin identities and sends unlink requests to the edge", async () => {
    vi.stubGlobal("document", { cookie: "dsh_csrf=csrf-token" });
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === "DELETE") return new Response(JSON.stringify({ ok: true, identity: { provider: "feishu", subject: "ou_x", unionId: null, createdAt: "2026-01-01" } }), { status: 200 });
      return new Response(JSON.stringify({ identities: [{
        provider: "feishu", subject: "ou_x", unionId: "un_1", createdAt: "2026-01-01",
        user: { id: "u1", email: "u@example.com", displayName: "User", role: "user" },
      }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    await expect(fetchAdminIdentities()).resolves.toMatchObject({ identities: [{ provider: "feishu", user: { id: "u1" } }] });
    await unlinkAdminIdentity("u1", "ou_x");
    expect(request.mock.calls[1]?.[0]).toBe("/auth/admin/identities");
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ provider: "feishu", subject: "ou_x", userId: "u1" });
  });

  it("adds credit on top of the freshly fetched monthly limit", async () => {
    const quota = { scope: { tenantId: "t", botId: "b", deploymentId: "d", userId: "u1" }, periodStart: "2026-09-01", monthlyLimitUsd: 10, usedUsd: 9.5, remainingUsd: 0.5 };
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (args[1]?.method === "PUT") return new Response(JSON.stringify({ ...quota, monthlyLimitUsd: 20, remainingUsd: 10.5 }), { status: 200 });
      return new Response(JSON.stringify(quota), { status: 200 });
    });
    vi.stubGlobal("fetch", request);

    await expect(addBillingCredit("u1", 10)).resolves.toMatchObject({ monthlyLimitUsd: 20 });
    expect(JSON.parse(String(request.mock.calls[1]?.[1]?.body))).toEqual({ userId: "u1", monthlyLimitUsd: 20 });
  });
});
