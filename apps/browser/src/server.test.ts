import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";

import type { BrowserConfig } from "./config.js";
import { BrowserAppError } from "./errors.js";
import type { BrowserManager } from "./manager.js";
import { createBrowserServer } from "./server.js";

const servers: Server[] = [];
const validScope = {
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId("user"), conversationId: makeConversationId("conversation"),
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Browser HTTP API", () => {
  it("要求 Bearer、固定路由和 POST", async () => {
    const manager = { execute: vi.fn() } as unknown as BrowserManager;
    const base = await listen(manager);
    expect((await fetch(`${base}/api/browser/action`)).status).toBe(401);
    expect((await fetch(`${base}/missing`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${base}/api/browser/action`, { headers: auth() })).status).toBe(405);
  });

  it("校验完整 Scope 并分派操作", async () => {
    const execute = vi.fn().mockResolvedValue({ url: "https://example.com/" });
    const base = await listen({ execute } as unknown as BrowserManager);
    const response = await post(base, { scope: validScope, operation: "open", workspace: "/workspace", url: "https://example.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "https://example.com/" });
    expect(execute).toHaveBeenCalledWith(validScope, { operation: "open", workspace: "/workspace", url: "https://example.com" });
    expect((await post(base, { scope: { userId: "x" }, operation: "open" })).status).toBe(400);
    expect((await post(base, { scope: validScope, operation: "unknown" })).status).toBe(400);
  });

  it("不向响应泄露内部异常", async () => {
    const manager = { execute: vi.fn().mockRejectedValue(new Error("Bearer secret-value")) } as unknown as BrowserManager;
    const response = await post(await listen(manager), { scope: validScope, operation: "snapshot" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "BROWSER_UPSTREAM", message: "BROWSER_UPSTREAM", retryable: true },
    });
  });

  it("将操作超时稳定映射为 504", async () => {
    const manager = { execute: vi.fn().mockRejectedValue(new BrowserAppError("BROWSER_TIMEOUT")) } as unknown as BrowserManager;
    const response = await post(await listen(manager), { scope: validScope, operation: "snapshot" });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: "BROWSER_TIMEOUT", message: "BROWSER_TIMEOUT", retryable: true },
    });
  });
  it("页面脚本错误返回422且不建议重试，也不回显表达式", async () => {
    const manager = { execute: vi.fn().mockRejectedValue(new BrowserAppError("BROWSER_SCRIPT_ERROR", "secret script")) } as unknown as BrowserManager;
    const response = await post(await listen(manager), { scope: validScope, operation: "evaluate", expression: "bad syntax" });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "BROWSER_SCRIPT_ERROR", message: "BROWSER_SCRIPT_ERROR", retryable: false } });
  });
});

async function listen(manager: BrowserManager): Promise<string> {
  const server = createBrowserServer({ bearerToken: "test-token", maxRequestBytes: 4_096 } as BrowserConfig, manager);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function auth(): Record<string, string> {
  return { authorization: "Bearer test-token" };
}

function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/browser/action`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
