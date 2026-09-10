import { describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";
import { BrowserHttpClient } from "./client.js";

const scope = {
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId("user"), conversationId: makeConversationId("conversation"),
};

describe("BrowserHttpClient", () => {
  it("调用固定端点，Bearer 不进入 JSON 请求体", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ url: "https://example.com/", title: "Example" }));
    const client = new BrowserHttpClient({ baseUrl: "http://127.0.0.1:13083", token: "secret", requestTimeoutMs: 1_000, fetch: fetchMock });
    await client.open({ scope, workspace: "/workspace", url: "https://example.com/" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:13083/api/browser/action");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({ scope, workspace: "/workspace", url: "https://example.com/", operation: "open" });
    expect(init.body).not.toContain("secret");
  });

  it("解析结构化错误并保留可重试属性", async () => {
    const client = new BrowserHttpClient({
      baseUrl: "http://127.0.0.1:13083", token: "secret", requestTimeoutMs: 1_000,
      fetch: vi.fn().mockResolvedValue(Response.json({ error: { code: "BROWSER_TIMEOUT", message: "等待超时", retryable: true } }, { status: 504 })),
    });
    await expect(client.snapshot({ scope })).rejects.toMatchObject({ code: "BROWSER_TIMEOUT", status: 504, retryable: true, message: "等待超时" });
  });

  it("拒绝越界响应与绝对截图路径", async () => {
    const invalidSnapshot = new BrowserHttpClient({
      baseUrl: "http://127.0.0.1:13083", token: "secret", requestTimeoutMs: 1_000,
      fetch: vi.fn().mockResolvedValue(Response.json({ url: "u", nodes: [{ name: "x".repeat(120_001) }] })),
    });
    await expect(invalidSnapshot.snapshot({ scope })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    const invalidScreenshot = new BrowserHttpClient({
      baseUrl: "http://127.0.0.1:13083", token: "secret", requestTimeoutMs: 1_000,
      fetch: vi.fn().mockResolvedValue(Response.json({ path: "/tmp/x.png" })),
    });
    await expect(invalidScreenshot.screenshot({ scope, workspace: "/workspace" })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
  });
});
