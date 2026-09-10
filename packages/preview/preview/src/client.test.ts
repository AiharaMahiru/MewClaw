import { describe, expect, it, vi } from "vitest";
import { makeBotId, makeConversationId, makeDeploymentId, makeTenantId, makeUserId } from "dsh-lark-contracts";

import { PreviewHttpClient } from "./client.js";

const scope = {
  tenantId: makeTenantId("tenant"), botId: makeBotId("bot"), deploymentId: makeDeploymentId("deployment"),
  userId: makeUserId("user"), conversationId: makeConversationId("conversation"),
};

describe("PreviewHttpClient", () => {
  it("使用内部 Bearer 调用 create/list/revoke", async () => {
    const descriptor = { id: "a".repeat(32), url: "https://chat.rwr.ink/share/a/", createdAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString(), port: 3000 };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(descriptor), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new PreviewHttpClient({ baseUrl: "http://127.0.0.1:13082", token: "secret", requestTimeoutMs: 1_000, fetch: fetchMock });
    await client.publish({ scope, workspace: "/workspace", command: "node server.js", port: 3000 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toMatchObject({ scope, workspace: "/workspace", port: 3000 });
  });

  it("保留 daemon 的标准错误分类", async () => {
    const client = new PreviewHttpClient({
      baseUrl: "http://127.0.0.1:13082", token: "secret", requestTimeoutMs: 1_000,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "PREVIEW_QUOTA" }), { status: 429 })),
    });
    await expect(client.list(scope)).rejects.toMatchObject({ code: "PREVIEW_QUOTA" });
  });
});
