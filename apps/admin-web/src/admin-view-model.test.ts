import { describe, expect, it } from "vitest";

import type { AdminSessionSummary, AdminUserSummary, BillingAggregate } from "./api.js";
import { billingTotals, filterSessions, filterUsers, sessionActivityPoints } from "./admin-view-model.js";

const user: AdminUserSummary = {
  id: "user-1", email: "admin@example.com", displayName: "管理员", role: "admin",
  status: "active", defaultMode: "full", createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z", sessionCount: 2, workspaceCount: 1, identityCount: 1,
};

const session: AdminSessionSummary = {
  id: "session-1", userId: user.id, email: user.email, displayName: user.displayName,
  role: "admin", createdAt: "2026-08-22T10:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z",
  lastSeenAt: "2026-08-22T10:00:00.000Z", revokedAt: null,
};

describe("admin view model", () => {
  it("filters users and sessions by visible identity and state", () => {
    expect(filterUsers([user], "ADMIN@", "active")).toEqual([user]);
    expect(filterUsers([user], "missing", "all")).toEqual([]);
    expect(filterSessions([session], "管理员", "active", Date.parse("2026-08-23T00:00:00.000Z"))).toEqual([session]);
  });

  it("anchors seven-day activity to the current day", () => {
    const points = sessionActivityPoints([session], new Date("2026-08-23T12:00:00.000Z"));
    expect(points).toHaveLength(7);
    expect(points.at(-1)?.key).toBe("2026-08-23");
    expect(points.find((point) => point.key === "2026-08-22")?.value).toBe(1);
  });

  it("aggregates token, call, model and USD totals", () => {
    const row = { provider: "openai", model: "gpt-5", calls: 2, inputTokens: 10,
      outputTokens: 5, reasoningTokens: 3, totalUsd: 0.25 } as BillingAggregate;
    expect(billingTotals([row])).toEqual({ calls: 2, tokens: 18, totalUsd: 0.25, models: 1 });
  });
});
