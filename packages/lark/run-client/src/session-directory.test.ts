import { describe, expect, it, vi } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session";
import { parseScope } from "dsh-lark-contracts";

import { createRunClient } from "./client.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scope = parsedScope.value;

function client(fetchMock: ReturnType<typeof vi.fn>) {
  return createRunClient({
    baseURL: "http://worker", connectTimeoutMs: 1_000, heartbeatToleranceMs: 1_000,
    maxEventBytes: 65_536, maxResponseBytes: 65_536, fetch: fetchMock as typeof fetch,
  });
}

describe("run-client session directory wire", () => {
  it("current/list/claim/use/new/unlink 使用固定窄端点和完整 Scope + generation", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      const path = new URL(url).pathname;
      const body = path.endsWith("/list")
        ? { sessions: [] }
        : path.endsWith("/new") || path.endsWith("/unlink")
          ? { mode: "deterministic" }
          : { mode: "shared", sessionId: "web-1" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const runClient = client(fetchMock);
    const base = { scope, sessionGeneration: 3 };
    const sessionId = SessionId("web-1");

    await runClient.sessionCurrent(base);
    await runClient.sessionList(base);
    await runClient.sessionClaim({ ...base, code: "A".repeat(24) });
    await runClient.sessionUse({ ...base, sessionId });
    await runClient.sessionNew(base);
    await runClient.sessionUnlink(base);

    expect(fetchMock.mock.calls.map(([url]) => new URL(url as string).pathname)).toEqual([
      "/v1/session-directory/current", "/v1/session-directory/list", "/v1/session-directory/claim",
      "/v1/session-directory/use", "/v1/session-directory/new", "/v1/session-directory/unlink",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body))).toMatchObject(base);
    }
  });

  it("拒绝含 cwd 或未知字段的 Worker 响应", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessions: [{
        sessionId: "web-1", selected: true, claimedAt: "2026-08-18T00:00:00.000Z",
        lastUsedAt: "2026-08-18T00:00:00.000Z", cwd: "D:/secret",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(client(fetchMock).sessionList({ scope, sessionGeneration: 0 })).rejects.toMatchObject({
      code: "RESPONSE_SCHEMA_ERROR",
    });
  });
});
