import { afterEach, describe, expect, it, vi } from "vitest";

import { LarkError, parseScope } from "dsh-lark-contracts";

import { createRunServer, type RunServer, type RunServerOptions } from "./http.js";

const parsedScope = parseScope({
  tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_http", conversationId: "oc_http",
});
if (!parsedScope.ok) throw new Error("unreachable");
const scope = parsedScope.value;

let server: RunServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function options() {
  const sessionDirectory = {
    current: vi.fn(async () => ({ mode: "shared", sessionId: "web-1" })),
    list: vi.fn(async () => ({ sessions: [] })),
    claim: vi.fn(async () => ({ mode: "shared", sessionId: "web-1" })),
    use: vi.fn(async () => ({ mode: "shared", sessionId: "web-1" })),
    newSession: vi.fn(async () => ({ mode: "deterministic" })),
    unlink: vi.fn(async () => ({ mode: "deterministic" })),
  };
  return {
    server: {
      host: "127.0.0.1", port: 0, token: "secret", enqueue: vi.fn(), cancel: vi.fn(),
      resolveInteraction: vi.fn(), sessionOverview: vi.fn(), readArtifact: vi.fn(),
      queueDepth: () => 0, heartbeatIntervalMs: 1_000, sessionDirectory,
    } as unknown as RunServerOptions,
    sessionDirectory,
  };
}

async function post(url: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("session-directory HTTP", () => {
  it("六个窄端点传递严格 DTO，并且响应不泄露 cwd", async () => {
    const env = options();
    server = await createRunServer(env.server);
    const base = { scope, sessionGeneration: 2 };
    const requests = [
      ["current", base, "current"], ["list", base, "list"],
      ["claim", { ...base, code: "A".repeat(24) }, "claim"],
      ["use", { ...base, sessionId: "web-1" }, "use"],
      ["new", base, "newSession"], ["unlink", base, "unlink"],
    ] as const;

    for (const [path, body, method] of requests) {
      const response = await post(server.url, `/v1/session-directory/${path}`, body);
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("cwd");
      expect(env.sessionDirectory[method]).toHaveBeenCalledWith(body);
    }
  });

  it("未知字段、非法 code 与未品牌化 sessionId 在 provider 前拒绝", async () => {
    const env = options();
    server = await createRunServer(env.server);
    const base = { scope, sessionGeneration: 0 };
    const requests = [
      ["current", { ...base, extra: true }],
      ["claim", { ...base, code: "short" }],
      ["use", { ...base, sessionId: "bad\nsession" }],
    ] as const;

    for (const [path, body] of requests) {
      expect((await post(server.url, `/v1/session-directory/${path}`, body)).status).toBe(400);
    }
    expect(env.sessionDirectory.current).not.toHaveBeenCalled();
    expect(env.sessionDirectory.claim).not.toHaveBeenCalled();
    expect(env.sessionDirectory.use).not.toHaveBeenCalled();
  });

  it("目录拒绝使用稳定状态码与清理后的错误 DTO", async () => {
    const env = options();
    env.sessionDirectory.use.mockRejectedValueOnce(
      new LarkError("SESSION_NOT_AVAILABLE", "user-visible", "会话不可用或未授权"),
    );
    env.sessionDirectory.claim.mockRejectedValueOnce(
      new LarkError("SESSION_CLAIM_INVALID", "user-visible", "分享码无效或已过期"),
    );
    server = await createRunServer(env.server);
    const base = { scope, sessionGeneration: 0 };

    const unavailable = await post(server.url, "/v1/session-directory/use", { ...base, sessionId: "web-1" });
    expect(unavailable.status).toBe(404);
    expect(await unavailable.json()).toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
    const invalidClaim = await post(server.url, "/v1/session-directory/claim", { ...base, code: "A".repeat(24) });
    expect(invalidClaim.status).toBe(400);
    expect(await invalidClaim.json()).toMatchObject({ code: "SESSION_CLAIM_INVALID" });
  });
});
