import type { AddressInfo } from "node:net";
import { request } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";

import type { AppConfig } from "./config.js";
import type { PreviewManager } from "./manager.js";
import { PreviewRequestTimeoutError } from "./proxy.js";
import { createPreviewServer, PreviewRequestLimiter } from "./server.js";

const servers: ReturnType<typeof createPreviewServer>[] = [];
const scope = {
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId("user-a"), conversationId: makeConversationId("conversation"),
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Preview control HTTP", () => {
  it("所有控制请求要求内部 Bearer，并按 typed service 转发", async () => {
    const descriptor = { id: "a".repeat(32), url: `https://chat.rwr.ink/share/${"a".repeat(32)}/`, createdAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(), port: 3000 };
    const manager = {
      publish: vi.fn().mockResolvedValue(descriptor), list: vi.fn().mockResolvedValue([descriptor]), revoke: vi.fn().mockResolvedValue(undefined),
    } as unknown as PreviewManager;
    const base = await listen(manager);
    const unauthorized = await fetch(`${base}/api/preview/list`, { method: "POST", body: JSON.stringify({ scope }) });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${base}/api/preview/create`, {
      method: "POST",
      headers: { authorization: "Bearer worker-test-token", "content-type": "application/json" },
      body: JSON.stringify({ scope, workspace: "/workspace", command: "node server.js", port: 3000, ttlMinutes: 10 }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(descriptor);
    expect(manager.publish).toHaveBeenCalledWith({ scope, workspace: "/workspace", command: "node server.js", port: 3000, ttlMinutes: 10 });
  });

  it("拒绝非法 Scope、非 POST 控制请求和 TRACE 分享请求", async () => {
    const manager = { list: vi.fn() } as unknown as PreviewManager;
    const base = await listen(manager);
    const headers = { authorization: "Bearer worker-test-token", "content-type": "application/json" };
    expect((await fetch(`${base}/api/preview/list`, { method: "POST", headers, body: JSON.stringify({ scope: { userId: "x" } }) })).status).toBe(400);
    expect((await fetch(`${base}/api/preview/list`, { headers })).status).toBe(405);
    expect(await requestStatus(`${base}/share/${"a".repeat(32)}/`, "TRACE", headers)).toBe(405);
  });

  it("用户服务超时返回 504", async () => {
    const manager = {
      resolvePublic: vi.fn().mockRejectedValue(new PreviewRequestTimeoutError()),
    } as unknown as PreviewManager;
    const base = await listen(manager);
    const headers = { authorization: "Bearer worker-test-token" };
    expect(await requestStatus(`${base}/share/${"a".repeat(32)}/`, "GET", headers)).toBe(504);
  });

  it("失败诊断只记录路由和错误码", async () => {
    const failures: unknown[] = [];
    const manager = {
      publish: vi.fn().mockRejectedValue(new Error("secret-command /private/workspace")),
    } as unknown as PreviewManager;
    const base = await listen(manager, (failure) => failures.push(failure));
    const response = await fetch(`${base}/api/preview/create`, {
      method: "POST",
      headers: { authorization: "Bearer worker-test-token", "content-type": "application/json" },
      body: JSON.stringify({ scope, workspace: "/private/workspace", command: "secret-command", port: 3000 }),
    });
    expect(response.status).toBe(503);
    expect(failures).toEqual([{ code: "PREVIEW_UNAVAILABLE", route: "create" }]);
    expect(JSON.stringify(failures)).not.toMatch(/secret-command|private\/workspace/u);
  });

  it("并发限制器达到上限后拒绝，并支持幂等释放", () => {
    const limiter = new PreviewRequestLimiter(1);
    const release = limiter.acquire();
    expect(release).toBeTypeOf("function");
    expect(limiter.acquire()).toBeUndefined();
    release?.();
    release?.();
    expect(limiter.acquire()).toBeTypeOf("function");
  });
});

async function listen(manager: PreviewManager, onFailure?: Parameters<typeof createPreviewServer>[2]): Promise<string> {
  const server = createPreviewServer({ workerToken: "worker-test-token", maxRequestBytes: 1_024, requestTimeoutMs: 1_000, maxConcurrentRequests: 8 } as AppConfig, manager, onFailure);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function requestStatus(url: string, method: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.once("error", reject);
    req.end();
  });
}
