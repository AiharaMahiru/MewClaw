import { afterEach, describe, it, expect } from "vitest";
import { AuthService, MemoryAuthStore, hashOpaqueToken } from "dsh-lark-auth";
import { createAuthEdgeServer } from "./server.js";
import type { AuthEdgeConfig } from "./config.js";
const close: Array<() => Promise<void>> = [];
afterEach(async () => { while (close.length) await close.pop()!(); });
describe("机器人账户HTTP边界", () => {
  it("真实HTTP拒绝未登录/CSRF/指定owner/内部Cookie，配置仅当前用户可见", async () => {
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail: { sendVerification: async () => {}, sendPasswordReset: async () => {} }, userModelEncryptionKey: Buffer.alloc(32, 8).toString("base64") });
    const now = new Date().toISOString();
    for (const token of ["test-user-a", "test-user-b"]) {
      const user = await store.createUser({ email: `${token}@test.invalid`, displayName: "test", status: "active", now });
      await store.createSession({ userId: user.id, tokenHash: hashOpaqueToken(token), createdAt: now, expiresAt: new Date(Date.now() + 60000).toISOString(), ipHash: null, userAgentHash: null });
    }
    const config: AuthEdgeConfig = { host: "127.0.0.1", port: 0, workerBaseUrl: "http://127.0.0.1:1", publicOrigin: "http://127.0.0.1", trustedOrigins: [], sessionCookieSecure: false, databaseUrl: "unused", userModelEncryptionKey: Buffer.alloc(32,8).toString("base64"), userWorkspaceRoot: "/tmp/test-bots", adminWorkspaceRoot: "/tmp/test-bots-admin", requestBodyLimit: 65536, pairingToken: "fake-internal-token", mail: { mode: "console", port: 465, secure: true } };
    const edge = createAuthEdgeServer({ service, config }); await edge.listen(); close.push(() => edge.close());
    const address = edge.server.address(); if (!address || typeof address === "string") throw Error("address");
    const base = `http://127.0.0.1:${address.port}`; (config.trustedOrigins as string[]).push(base);
    const headers = { cookie: "dsh_session=test-user-a; dsh_csrf=test-csrf", origin: base, "x-csrf-token": "test-csrf", "content-type": "application/json" };
    const body = { expectedRevision: 0, appId: "cli_1234567890abcdef", appSecret: "fake-secret", domain: "https://open.feishu.cn", authorizedOpenIds: ["ou_test"] };
    expect((await fetch(`${base}/auth/feishu-bot`)).status).toBe(401);
    expect((await fetch(`${base}/auth/feishu-bot`, { method: "PUT", headers: { cookie: headers.cookie }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await fetch(`${base}/auth/feishu-bot`, { method: "PUT", headers, body: JSON.stringify({ ...body, userId: "other" }) })).status).toBe(400);
    const saved = await fetch(`${base}/auth/feishu-bot`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(saved.status).toBe(200); expect(await saved.text()).not.toContain("fake-secret");
    expect(await (await fetch(`${base}/auth/feishu-bot`, { headers: { cookie: "dsh_session=test-user-b" } })).json()).toEqual({ bot: null });
    expect((await fetch(`${base}/internal/feishu-bots`)).status).toBe(401);
    expect((await fetch(`${base}/internal/feishu-bots`, { headers: { cookie: headers.cookie, authorization: "Bearer fake-internal-token" } })).status).toBe(403);
    expect(await (await fetch(`${base}/internal/feishu-bots`, { headers: { authorization: "Bearer fake-internal-token" } })).json()).toEqual({ bots: [] });
  });
});
