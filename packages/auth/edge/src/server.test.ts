import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { AuthService, MemoryAuthStore, type MailSender } from "dsh-lark-auth";

import { createAuthEdgeServer } from "./server.js";
import type { AuthEdgeConfig } from "./config.js";
import { OAUTH_STATE_COOKIE } from "./cookies.js";

class FakeMail implements MailSender {
  readonly verification: string[] = [];
  readonly reset: string[] = [];
  async sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void> { this.verification.push(input.code); }
  async sendPasswordReset(input: { to: string; displayName: string; token: string }): Promise<void> { this.reset.push(input.token); }
}

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

describe("AuthEdgeServer", () => {
  it.each(["allow", "block", "unavailable", "missing", "throw"] as const)("提示词审计 %s 时覆盖全部入口并严格控制 Worker 转发", async (result) => {
    const forwarded: string[] = [];
    const audited: string[] = [];
    const worker = await listen((req, res) => {
      void collect(req).then((body) => { forwarded.push(body); json(res, 200, { ok: true }); });
    });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("audit@example.com", "correct horse battery staple", "审计测试", { requestId: "test" });
    const user = await verifyLatest(service, mail, "audit@example.com");
    for (const resourceId of ["audit-parent", "audit-child"]) {
      await service.saveResource({ resourceType: "session", resourceId, userId: user!.user.id, resourcePath: null, createdAt: "2026-09-07T00:00:00.000Z" });
    }
    const edgeConfig = config(worker.port);
    edgeConfig.promptAudit = { enabled: true, timeoutMs: 1000, maxConcurrent: 2 };
    const edge = createAuthEdgeServer({
      config: edgeConfig,
      service,
      ...(result === "missing" ? {} : { promptAuditor: { audit: async (text: string) => {
        audited.push(text);
        if (result === "throw") throw new Error("内部审计故障，不得外传");
        return result;
      } } }),
    });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });
    const headers = { origin: base, cookie: `dsh_session=${user!.token}; dsh_csrf=audit-test-csrf`, "x-csrf-token": "audit-test-csrf", "content-type": "application/json" };
    const variants = [
      { method: "session/prompt", args: { request: { sessionId: "audit-parent", text: "请整理项目说明" } } },
      { method: "session.prompt", args: { sessionId: "audit-parent", text: "请整理项目说明" } },
      { method: "session/updateQueue", args: { request: { sessionId: "audit-parent", action: { kind: "edit", messageId: "queued-message", content: [{ type: "text", text: "请整理项目说明" }] } } } },
      { method: "subagents/prompt", args: { request: { parentSessionId: "audit-parent", childSessionId: "audit-child", text: "请整理项目说明" } } },
      { method: "goals/create", args: { agentId: "audit-parent", request: { objective: "请整理项目说明" } } },
      { method: "goals/edit", args: { agentId: "audit-parent", ref: { id: "goal-1", revision: 1 }, request: { objective: "请整理项目说明" } } },
      { method: "commands/execute", args: { agentId: "audit-parent", line: "请整理项目说明" } },
    ];
    for (const variant of variants) {
      const body = JSON.stringify({ rpcId: "audit-rpc", method: variant.method, payload: { args: variant.args } });
      const response = await fetch(`${base}/api/${variant.method}`, { method: "POST", headers, body });
      expect(response.status).toBe(200);
      if (result === "allow") expect(forwarded.at(-1)).toBe(body);
      else expect(await response.json()).toEqual({
        type: "server-response",
        rpcId: "audit-rpc",
        result: {
          ok: false,
          error: result === "block"
            ? { code: "prompt/security-blocked", message: "禁止网络攻防、恶意攻击和破解类请求，本次提示词未发送。请修改内容后重试。", details: {} }
            : { code: "prompt/security-unavailable", message: "安全审计暂时不可用，本次提示词未发送。请稍后重试。", details: {} },
        },
      });
      const malformed = await fetch(`${base}/api/${variant.method}`, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body });
      expect(malformed.status).toBe(400);
    }
    expect(forwarded).toHaveLength(result === "allow" ? variants.length : 0);
    expect(audited).toEqual(result === "missing" ? [] : variants.map(() => "请整理项目说明"));

    const before = audited.length;
    const body = JSON.stringify({ method: "session/prompt", payload: { args: { request: { sessionId: "audit-parent", text: "未经授权的内容" } } } });
    const guest = await fetch(`${base}/api/session/prompt`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body });
    expect([401, 403]).toContain(guest.status);
    const crossOrigin = await fetch(`${base}/api/session/prompt`, { method: "POST", headers: { ...headers, origin: "https://untrusted.invalid" }, body });
    expect(crossOrigin.status).toBe(403);
    expect(audited).toHaveLength(before);
    expect(forwarded).toHaveLength(result === "allow" ? variants.length : 0);
  });

  it("serves Web UI assets without requiring a user session", async () => {
    const forwarded: Array<{ path: string; authorization?: string; cookie?: string }> = [];
    const worker = await listen((req, res) => {
      const request: { path: string; authorization?: string; cookie?: string } = { path: req.url ?? "" };
      const authorization = header(req, "authorization");
      const cookie = header(req, "cookie");
      if (authorization !== undefined) request.authorization = authorization;
      if (cookie !== undefined) request.cookie = cookie;
      forwarded.push(request);
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("window.__ModuleLoader__;");
    });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service: new AuthService({ store: new MemoryAuthStore(), mail: new FakeMail() }) });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const asset = await fetch(`${base}/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js?rev=test`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("__ModuleLoader__");
    expect(forwarded).toEqual([{ path: "/plugins/@deepseek-ai/dsh-client-ui-agent-preset/client.js?rev=test", cookie: "dsh_worker=test" }]);

    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(forwarded.at(-1)).toEqual({ path: "/mewclaw-brand/manifest.webmanifest", cookie: "dsh_worker=test" });

    const favicon = await fetch(`${base}/favicon.ico`);
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toBe("text/javascript");
    expect(forwarded.at(-1)).toEqual({ path: "/mewclaw-brand/favicon.svg", cookie: "dsh_worker=test" });

    const directManifest = await fetch(`${base}/mewclaw-brand/manifest.webmanifest`);
    expect(directManifest.status).toBe(200);
    expect(forwarded.at(-1)).toEqual({ path: "/mewclaw-brand/manifest.webmanifest", cookie: "dsh_worker=test" });

    const directFavicon = await fetch(`${base}/mewclaw-brand/favicon.svg`);
    expect(directFavicon.status).toBe(200);
    expect(forwarded.at(-1)).toEqual({ path: "/mewclaw-brand/favicon.svg", cookie: "dsh_worker=test" });

    const protectedApi = await fetch(`${base}/api/commands/list`);
    expect(protectedApi.status).toBe(401);
  });

  it("serves only /admin and rejects the slash-suffixed path", async () => {
    const forwarded: string[] = [];
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const admin = await listen((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(200, { "content-type": "text/html" }); res.end("admin"); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const verified = await verifyLatest(service, mail, "admin@example.com");
    const edgeConfig = config(worker.port);
    edgeConfig.adminBaseUrl = `http://127.0.0.1:${admin.port}`;
    edgeConfig.adminToken = "admin-secret";
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const session = `dsh_session=${verified!.token}`;
    const unsupported = await fetch(`${base}/admin/?view=summary`, { headers: { cookie: session } });
    expect(unsupported.status).toBe(404);
    expect(await unsupported.json()).toEqual({ error: "NOT_FOUND" });

    const page = await fetch(`${base}/admin?view=summary`, { headers: { cookie: session } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("admin");
    expect(forwarded).toEqual(["/admin?view=summary"]);
  });

  it("gates the official API and proxies an authenticated same-origin RPC", async () => {
    const upstreamRequests: Array<{ path?: string; authorization?: string; csrf?: string; cookie?: string; origin?: string; body: string }> = [];
    const worker = await listen((req, res) => {
      if (req.method === "POST") {
        collect(req).then((body) => {
          const request: { path?: string; authorization?: string; csrf?: string; cookie?: string; origin?: string; body: string } = { body };
          if (req.url !== undefined) request.path = req.url;
          const authorization = header(req, "authorization");
          const csrf = header(req, "x-csrf-token");
          const cookie = header(req, "cookie");
          const origin = header(req, "origin");
          if (authorization !== undefined) request.authorization = authorization;
          if (csrf !== undefined) request.csrf = csrf;
          if (cookie !== undefined) request.cookie = cookie;
          if (origin !== undefined) request.origin = origin;
          upstreamRequests.push(request);
          if (req.url === "/api/dsh-web-ui-settings/describe") {
            json(res, 200, { ok: true, value: { namespaces: [{ ns: "skin" }], writable: true } });
            return;
          }
          json(res, 200, { result: { value: { items: [] } } });
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><head></head><body><script>globalThis["__DSH_BOOT__"] = {"rev":"original","entries":[{"id":"@deepseek-ai/dsh-cordis-client-runner"},{"id":"@deepseek-ai/dsh-client-ui-cordis"},{"id":"@linxin666/dsh-web-all"},{"id":"safe-client"}],"batches":[{"phase":"application","url":"/plugins/runner","rev":"r","entries":["@deepseek-ai/dsh-cordis-client-runner","@linxin666/dsh-web-all","safe-client"]},{"phase":"application","url":"/plugins/cordis","rev":"r","entries":["@deepseek-ai/dsh-client-ui-cordis"]}]}</script></body></html>');
    });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const unauthenticated = await fetch(`${base}/api/commands/list`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ method: "commands/list", payload: { args: { agentId: "missing" } } }) });
    expect(unauthenticated.status).toBe(403);

    const landing = await fetch(`${base}/`);
    const landingCookie = firstCookie(landing);
    const csrf = cookieValue(landingCookie, "dsh_csrf");
    const register = await fetch(`${base}/auth/register`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", password: "correct horse battery staple", displayName: "Admin" }) });
    expect(register.status).toBe(202);
    const verified = await fetch(`${base}/auth/verify`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.com", code: mail.verification[0] }) });
    expect(verified.status).toBe(200);
    const sessionCookie = cookies(verified).join("; ");
    const rpc = await fetch(`${base}/api/commands/list`, { method: "POST", headers: { origin: base, cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ method: "commands/list", payload: { args: { agentId: "missing" } } }) });
    expect(rpc.status).toBe(200);
    expect(upstreamRequests[0]).toMatchObject({ cookie: "dsh_worker=test", csrf: expect.any(String) });
    expect(upstreamRequests[0]?.origin).toBe(`http://127.0.0.1:${worker.port}`);
    expect(upstreamRequests[0]?.authorization).toBeUndefined();

    const adminHome = await fetch(`${base}/`, { headers: { cookie: sessionCookie } });
    expect(adminHome.status).toBe(200);
    expect(adminHome.headers.get("cache-control")).toBe("private, no-store");
    const adminHtml = await adminHome.text();
    expect(adminHtml).toContain("remoteAdminSettings:true");
    expect(adminHtml).not.toContain("ownsHost");
    expect(adminHtml).toContain("dsh.auth.account.v1");
    expect(adminHtml).toContain("@deepseek-ai/dsh-cordis-client-runner");
    expect(adminHtml).toContain("@deepseek-ai/dsh-client-ui-cordis");
    expect(adminHtml).not.toContain("@linxin666/dsh-web-all");

    const adminSettingsDescribe = await fetch(`${base}/api/dsh-web-ui-settings/describe`, {
      method: "POST",
      headers: { origin: base, cookie: sessionCookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(adminSettingsDescribe.status).toBe(200);
    expect(await adminSettingsDescribe.json()).toEqual({ ok: true, value: { namespaces: [{ ns: "skin" }], writable: true } });

    const memberRegister = await fetch(`${base}/auth/register`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", password: "correct horse battery staple", displayName: "Member" }) });
    expect(memberRegister.status).toBe(202);
    const memberVerified = await fetch(`${base}/auth/verify`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.com", code: mail.verification[1] }) });
    expect(memberVerified.status).toBe(200);
    const memberSessionOnly = cookies(memberVerified).find((value) => value.startsWith("dsh_session="));
    expect(memberSessionOnly).toBeTruthy();
    const legacyMemberHome = await fetch(`${base}/`, { headers: { cookie: memberSessionOnly! } });
    expect(cookies(legacyMemberHome).some((value) => value.startsWith("dsh_csrf=") && value.length > "dsh_csrf=".length)).toBe(true);
    const memberHome = await fetch(`${base}/`, { headers: { cookie: cookies(memberVerified).join("; ") } });
    const memberHtml = await memberHome.text();
    expect(memberHtml).toContain("__DSH_AUTH_EDGE__={remoteSettings:true};");
    expect(memberHtml).not.toContain("ownsHost");
    expect(memberHtml).toContain("localStorage.removeItem(x)");
    expect(memberHtml).not.toContain("remoteAdminSettings:true");
    expect(memberHtml).not.toContain("@deepseek-ai/dsh-cordis-client-runner");
    expect(memberHtml).not.toContain('"entries":["@deepseek-ai/dsh-cordis-client-runner"');
    expect(memberHtml).not.toContain("@deepseek-ai/dsh-client-ui-cordis");
    expect(memberHtml).not.toContain("@linxin666/dsh-web-all");
    expect(memberHtml).toContain("safe-client");
    const memberBoot = parseBootManifest(memberHtml);
    const memberEntryIds = new Set(memberBoot.entries.map((entry) => entry.id));
    const orphanedBatchEntries = (memberBoot.batches ?? []).flatMap((batch) =>
      Array.isArray(batch.entries)
        ? batch.entries.filter((entryId) => typeof entryId === "string" && !memberEntryIds.has(entryId))
        : [],
    );
    expect(orphanedBatchEntries).toEqual([]);
    expect(memberBoot.batches).toEqual([{ phase: "application", url: "/plugins/runner", rev: "r", entries: ["safe-client"] }]);
    const memberCookie = cookies(memberVerified).join("; ");
    const settingsDescribe = await fetch(`${base}/api/dsh-web-ui-settings/describe`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(settingsDescribe.status).toBe(200);
    expect(await settingsDescribe.json()).toEqual({ ok: true, value: { namespaces: [{ ns: "skin" }], writable: false } });
    expect(upstreamRequests.at(-1)).toMatchObject({ path: "/api/dsh-web-ui-settings/describe" });
    const forwardedBeforeMutation = upstreamRequests.length;
    const settingsMutate = await fetch(`${base}/api/dsh-web-ui-settings/mutate`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ ns: "skin", ops: [] }),
    });
    expect(settingsMutate.status).toBe(403);
    expect(upstreamRequests).toHaveLength(forwardedBeforeMutation);

    const response = await fetch(`${base}/api/respond`, { method: "POST", headers: { origin: base, cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ type: "client-response", rpcId: "approval-1", result: { ok: true, value: {} } }) });
    expect(response.status).toBe(200);
    expect(upstreamRequests.at(-1)).toMatchObject({ path: "/api/respond" });
  });

  it("validates verification code format and rejects a replay", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const landing = await fetch(`${base}/`);
    const landingCookie = firstCookie(landing);
    const csrf = cookieValue(landingCookie, "dsh_csrf");
    await fetch(`${base}/auth/register`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "codes@example.com", password: "correct horse battery staple", displayName: "Codes" }) });
    const verify = (code: string) => fetch(`${base}/auth/verify`, { method: "POST", headers: { origin: base, cookie: landingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ email: "codes@example.com", code }) });

    const malformed = await verify("12345");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "INVALID_VERIFICATION_CODE" });
    const wrong = await verify("999999");
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "VERIFICATION_CODE_INVALID" });
    const verified = await verify(mail.verification[0]!);
    expect(verified.status).toBe(200);
    const replay = await verify(mail.verification[0]!);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "VERIFICATION_CODE_INVALID" });
  });

  it("隔离用户私有模型配置，并只允许一次性 capability 解析运行时密钥", async () => {
    let scopeBinding: Record<string, unknown> | undefined;
    const worker = await listen((req, res) => {
      json(res, 200, { result: { value: { ok: true } } });
    }, (binding) => { scopeBinding = binding; });
    const mail = new FakeMail();
    const edgeConfig = config(worker.port);
    const service = new AuthService({
      store: new MemoryAuthStore(),
      mail,
      userModelEncryptionKey: Buffer.alloc(32, 71).toString("base64url"),
    });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await verifyLatest(service, mail, "admin@example.com");
    await service.register("member@example.com", "correct horse battery staple", "Member", { requestId: "test" });
    const member = await verifyLatest(service, mail, "member@example.com");
    await service.register("other@example.com", "correct horse battery staple", "Other", { requestId: "test" });
    const other = await verifyLatest(service, mail, "other@example.com");
    expect(member && other).toBeDefined();
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const landing = await fetch(`${base}/`);
    const csrfCookie = firstCookie(landing);
    const csrf = cookieValue(csrfCookie, "dsh_csrf");
    const memberCookie = `dsh_session=${member!.token}; ${csrfCookie}`;
    const otherCookie = `dsh_session=${other!.token}; ${csrfCookie}`;
    const profileBody = {
      displayName: "我的 CPA",
      baseUrl: "https://1.1.1.1/v1",
      modelIds: ["gpt-test"],
      defaultModel: "gpt-test",
      apiKey: "test-private-key-not-for-response",
    };

    const unauthenticated = await fetch(`${base}/auth/models`);
    expect(unauthenticated.status).toBe(401);
    const csrfRejected = await fetch(`${base}/auth/models`, {
      method: "POST",
      headers: { origin: base, cookie: `dsh_session=${member!.token}`, "content-type": "application/json" },
      body: JSON.stringify(profileBody),
    });
    expect(csrfRejected.status).toBe(403);
    const unsafe = await fetch(`${base}/auth/models`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ ...profileBody, baseUrl: "https://127.0.0.1/v1" }),
    });
    expect(unsafe.status).toBe(400);

    const created = await fetch(`${base}/auth/models`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify(profileBody),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { profile: { id: string; revision: number; keyConfigured: boolean } };
    expect(createdBody.profile.keyConfigured).toBe(true);
    expect(JSON.stringify(createdBody)).not.toContain(profileBody.apiKey);

    const ownList = await fetch(`${base}/auth/models`, { headers: { cookie: memberCookie } });
    expect(await ownList.json()).toMatchObject({ defaultProfileId: createdBody.profile.id, profiles: [{ id: createdBody.profile.id, keyConfigured: true }] });
    const otherList = await fetch(`${base}/auth/models`, { headers: { cookie: otherCookie } });
    expect(await otherList.json()).toEqual({ profiles: [] });
    const otherPatch = await fetch(`${base}/auth/models/${createdBody.profile.id}`, {
      method: "PATCH",
      headers: { origin: base, cookie: otherCookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: createdBody.profile.revision, displayName: "nope" }),
    });
    expect(otherPatch.status).toBe(404);

    await service.saveResource({ resourceType: "session", resourceId: "member-session", userId: member!.user.id, resourcePath: null, createdAt: "2026-09-01T00:00:00.000Z" });
    const prompt = await fetch(`${base}/api/session.prompt`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ rpcId: "private-route-rpc", method: "session.prompt", payload: { args: { sessionId: "member-session", text: "hello" } } }),
    });
    expect(prompt.status).toBe(200);
    expect(scopeBinding).toBeTruthy();
    const scope = scopeBinding as { modelRoute: Record<string, unknown>; sessionId: string; rpcId: string };
    expect(scope.modelRoute).toMatchObject({ mode: "private", profileId: createdBody.profile.id, revision: 1, model: "gpt-test" });
    expect(JSON.stringify(scope)).not.toContain(profileBody.apiKey);

    const officialPrompt = await fetch(`${base}/api/session/prompt`, {
      method: "POST",
      headers: { origin: base, cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ rpcId: "official-prompt-rpc", method: "session/prompt", payload: { args: { request: { sessionId: "member-session", text: "hello" } } } }),
    });
    expect(officialPrompt.status).toBe(200);
    expect(scopeBinding).toMatchObject({ sessionId: "member-session", rpcId: "official-prompt-rpc" });

    const routeRequest = {
      sessionId: scope.sessionId,
      rpcId: scope.rpcId,
      capability: scope.modelRoute.capability,
      profileId: scope.modelRoute.profileId,
      revision: scope.modelRoute.revision,
      model: scope.modelRoute.model,
    };
    const wrongRoute = await fetch(`${base}/internal/models/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ ...routeRequest, rpcId: "wrong-rpc" }),
    });
    expect(wrongRoute.status).toBe(404);
    const route = await fetch(`${base}/internal/models/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify(routeRequest),
    });
    expect(route.status).toBe(200);
    expect(route.headers.get("cache-control")).toBe("no-store");
    const replay = await fetch(`${base}/internal/models/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify(routeRequest),
    });
    expect(replay.status).toBe(404);
  });

  it("rejects a cross-site authenticated worker read before proxying", async () => {
    const forwarded: string[] = [];
    const worker = await listen((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(200); res.end("worker"); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const verified = await verifyLatest(service, mail, "admin@example.com");
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const response = await fetch(`${base}/`, { headers: { origin: "https://evil.invalid", cookie: `dsh_session=${verified!.token}` } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "ORIGIN_NOT_ALLOWED" });
    expect(forwarded).toEqual([]);
  });

  it("proxies @ reference candidates only for the member's sessions", async () => {
    const forwarded: string[] = [];
    const worker = await listen((req, res) => {
      forwarded.push(req.url ?? "");
      collect(req).then((body) => {
        const request = JSON.parse(body) as { method?: string };
        if (request.method === "fileReferences/list") {
          json(res, 200, { result: { value: [{ path: "src/index.ts", kind: "file" }] } });
          return;
        }
        json(res, 200, { result: { value: [
          { sessionId: "owned", label: "Mine", cwd: ownedWorkspace },
          { sessionId: "foreign", label: "Other", cwd: foreignWorkspace },
        ] } });
      });
    });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await verifyLatest(service, mail, "admin@example.com");
    await service.register("member@example.com", "correct horse battery staple", "Member", { requestId: "test" });
    const member = await verifyLatest(service, mail, "member@example.com");
    expect(member).toBeDefined();
    const edgeConfig = config(worker.port);
    const ownedWorkspace = `${edgeConfig.userWorkspaceRoot}/${member!.user.id}/project`;
    const foreignWorkspace = `${edgeConfig.userWorkspaceRoot}/other-user/project`;
    await service.saveResource({ resourceType: "session", resourceId: "owned", userId: member!.user.id, resourcePath: ownedWorkspace, createdAt: "2026-01-01T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "other-user", resourcePath: foreignWorkspace, createdAt: "2026-01-01T00:00:00.000Z" });
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });
    const landing = await fetch(`${base}/`);
    const csrfCookie = firstCookie(landing);
    const csrf = cookieValue(csrfCookie, "dsh_csrf");
    const headers = { origin: base, cookie: `dsh_session=${member!.token}; ${csrfCookie}`, "x-csrf-token": csrf, "content-type": "application/json" };

    const files = await fetch(`${base}/api/fileReferences/list`, { method: "POST", headers, body: JSON.stringify({ method: "fileReferences/list", payload: { args: { agentId: "owned", query: "src" } } }) });
    const filesBody = await files.json();
    expect({ status: files.status, body: filesBody }).toEqual({ status: 200, body: { result: { value: [{ path: "src/index.ts", kind: "file" }] } } });

    const sessions = await fetch(`${base}/api/sessionReferenceResolver/candidates`, { method: "POST", headers, body: JSON.stringify({ method: "sessionReferenceResolver/candidates", payload: { args: { agentId: "owned", query: "" } } }) });
    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toEqual({ result: { value: [{ sessionId: "owned", label: "Mine", cwd: "~/project" }] } });

    const forwardedBeforeForeign = forwarded.length;
    const foreign = await fetch(`${base}/api/fileReferences/list`, { method: "POST", headers, body: JSON.stringify({ method: "fileReferences/list", payload: { args: { agentId: "foreign", query: "" } } }) });
    expect(foreign.status).toBe(403);
    expect(forwarded).toHaveLength(forwardedBeforeForeign);
  });

  it("rejects a foreign session export before it reaches the Worker", async () => {
    const forwarded: string[] = [];
    const worker = await listen((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(200, { "content-type": "application/zip" }); res.end("zip"); });
    const mail = new FakeMail();
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await verifyLatest(service, mail, "admin@example.com");
    const registration = await service.register("user@example.com", "correct horse battery staple", "User", { requestId: "test" });
    expect(registration.accepted).toBe(true);
    const verified = await verifyLatest(service, mail, "user@example.com");
    expect(verified).toBeDefined();
    await service.saveResource({ resourceType: "session", resourceId: "foreign", userId: "other-user", resourcePath: "D:/workspaces/users/other-user", createdAt: "2026-01-01T00:00:00.000Z" });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });
    const denied = await fetch(`${base}/api/session.export?sessionId=foreign`, { headers: { cookie: `dsh_session=${verified!.token}` } });
    expect(denied.status).toBe(403);
    expect(forwarded).toEqual([]);
  });

  it("does not parse an empty JSON body for HEAD session export", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200, { "content-type": "application/json", "content-length": "0" }); res.end(); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const verified = await verifyLatest(service, mail, "admin@example.com");
    await service.saveResource({ resourceType: "session", resourceId: "owned", userId: verified!.user.id, resourcePath: "D:/workspaces/admin", createdAt: "2026-01-01T00:00:00.000Z" });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const response = await fetch(`${base}/api/session.export?sessionId=owned`, { method: "HEAD", headers: { cookie: `dsh_session=${verified!.token}` } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("serves a password reset form and rejects an untrusted origin", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end(); });
    const service = new AuthService({ store: new MemoryAuthStore(), mail: new FakeMail() });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });
    const reset = await fetch(`${base}/auth/reset?token=opaque-token`);
    expect(reset.status).toBe(200);
    expect(await reset.text()).toContain("opaque-token");
    const crossSite = await fetch(`${base}/auth/register`, { method: "POST", headers: { origin: "https://evil.invalid", "content-type": "application/json" }, body: "{}" });
    expect(crossSite.status).toBe(403);
  });

  it("redirects the retired account page to the DSH Web workspace", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("account@example.com", "correct horse battery staple", "Account Owner", { requestId: "test" });
    const verified = await verifyLatest(service, mail, "account@example.com");
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const guest = await fetch(`${base}/auth/account?section=feishu`, { redirect: "manual" });
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/");
    expect(await guest.text()).toBe("");

    const legacy = await fetch(`${base}/auth/account?section=feishu`, { redirect: "manual", headers: { cookie: `dsh_session=${verified!.token}` } });
    expect(legacy.status).toBe(302);
    expect(legacy.headers.get("location")).toBe("/");
    expect(cookies(legacy).some((value) => value.startsWith("dsh_csrf=") && value.length > "dsh_csrf=".length)).toBe(true);
    expect(await legacy.text()).toBe("");
  });

  it("scopes identity management to the current user and admin role", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = new AuthService({ store, mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const admin = await verifyLatest(service, mail, "admin@example.com");
    await service.register("member@example.com", "correct horse battery staple", "Member", { requestId: "test" });
    const member = await verifyLatest(service, mail, "member@example.com");
    const state = await service.beginOAuth(member!.user.id, "/");
    await service.completeFeishu(state.state, { openId: "ou_member", unionId: "on_member" }, { requestId: "test" });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const memberList = await fetch(`${base}/auth/identities`, { headers: { cookie: `dsh_session=${member!.token}` } });
    expect(memberList.status).toBe(200);
    expect(await memberList.json()).toMatchObject({ identities: [{ provider: "feishu", subject: "ou_member", unionId: "on_member" }] });
    const memberAdminList = await fetch(`${base}/auth/admin/identities`, { headers: { cookie: `dsh_session=${member!.token}` } });
    expect(memberAdminList.status).toBe(403);

    const memberPage = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${member!.token}` } });
    const memberCookies = cookies(memberPage).join("; ");
    const memberCsrf = cookieValue(memberCookies, "dsh_csrf");
    const crossUserDelete = await fetch(`${base}/auth/identities`, { method: "DELETE", headers: { origin: base, cookie: `dsh_session=${member!.token}; ${memberCookies}`, "x-csrf-token": memberCsrf, "content-type": "application/json" }, body: JSON.stringify({ provider: "feishu", subject: "ou_missing" }) });
    expect(crossUserDelete.status).toBe(404);
    const missingCsrf = await fetch(`${base}/auth/identities`, { method: "DELETE", headers: { origin: base, cookie: `dsh_session=${member!.token}; ${memberCookies}`, "content-type": "application/json" }, body: JSON.stringify({ provider: "feishu", subject: "ou_member" }) });
    expect(missingCsrf.status).toBe(403);

    const adminPage = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${admin!.token}` } });
    const adminCookies = cookies(adminPage).join("; ");
    const adminList = await fetch(`${base}/auth/admin/identities`, { headers: { cookie: `dsh_session=${admin!.token}` } });
    expect(adminList.status).toBe(200);
    expect(await adminList.json()).toMatchObject({ identities: [{ user: { email: "member@example.com" }, subject: "ou_member" }] });
    const adminDelete = await fetch(`${base}/auth/admin/identities`, { method: "DELETE", headers: { origin: base, cookie: `dsh_session=${admin!.token}; ${adminCookies}`, "x-csrf-token": cookieValue(adminCookies, "dsh_csrf"), "content-type": "application/json" }, body: JSON.stringify({ userId: member!.user.id, provider: "feishu", subject: "ou_member" }) });
    expect(adminDelete.status).toBe(200);
    expect(await store.findIdentity("feishu", "ou_member")).toBeUndefined();
  });

  it("revokes the session and clears the cookie on logout", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("logout@example.com", "correct horse battery staple", "Logout User", { requestId: "test" });
    const verified = await verifyLatest(service, mail, "logout@example.com");
    expect(verified).toBeDefined();
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const accountPage = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${verified!.token}` } });
    const csrfCookie = cookies(accountPage).join("; ");
    const csrf = cookieValue(csrfCookie, "dsh_csrf");
    const logout = await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: base, cookie: `dsh_session=${verified!.token}; ${csrfCookie}`, "x-csrf-token": csrf } });
    expect(logout.status).toBe(200);
    expect(cookies(logout)).toContain("dsh_session=");

    const me = await fetch(`${base}/auth/me`, { headers: { cookie: `dsh_session=${verified!.token}` } });
    expect(me.status).toBe(401);
    const account = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${verified!.token}` } });
    expect(account.status).toBe(302);
    expect(account.headers.get("location")).toBe("/");
  });

  it("limits better-sidebar HTTP resources to the owning session", async () => {
    const forwarded: string[] = [];
    const worker = await listen((req, res) => { forwarded.push(req.url ?? ""); res.writeHead(200); res.end("worker"); });
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = new AuthService({ store, mail });
    await service.register("owner-admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await verifyLatest(service, mail, "owner-admin@example.com");
    await service.register("owner-user@example.com", "correct horse battery staple", "Owner", { requestId: "test" });
    const user = await verifyLatest(service, mail, "owner-user@example.com");
    await service.saveResource({ resourceType: "session", resourceId: "owned-session", userId: user!.user.id, resourcePath: "D:/workspaces/users/owner", createdAt: "2026-08-20T00:00:00.000Z" });
    await service.saveResource({ resourceType: "session", resourceId: "foreign-session", userId: "other-user", resourcePath: "D:/workspaces/users/other", createdAt: "2026-08-20T00:00:00.000Z" });
    const edgeConfig = config(worker.port);
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const owned = await fetch(`${base}/sidebar/file?sessionId=owned-session&path=${encodeURIComponent("D:/workspaces/users/owner/a.txt")}`, { headers: { cookie: `dsh_session=${user!.token}` } });
    expect(owned.status).toBe(200);
    expect(owned.headers.get("x-frame-options")).toBe("DENY");
    expect(forwarded).toEqual([expect.stringContaining("sessionId=owned-session")]);
    const html = await fetch(`${base}/sidebar/html/owned-session/index.html`, { headers: { cookie: `dsh_session=${user!.token}` } });
    expect(html.status).toBe(200);
    expect(html.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const sidebarCsrf = "sidebar-csrf-token";
    const live = await fetch(`${base}/sidebar/api/subagents.live`, {
      method: "POST",
      headers: {
        origin: base,
        cookie: `dsh_session=${user!.token}; dsh_csrf=${sidebarCsrf}`,
        "x-csrf-token": sidebarCsrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ rootSessionId: "owned-session" }),
    });
    expect(live.status).toBe(200);
    const foreignLive = await fetch(`${base}/sidebar/api/subagents.live`, {
      method: "POST",
      headers: {
        origin: base,
        cookie: `dsh_session=${user!.token}; dsh_csrf=${sidebarCsrf}`,
        "x-csrf-token": sidebarCsrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ rootSessionId: "foreign-session" }),
    });
    expect(foreignLive.status).toBe(403);
    const foreign = await fetch(`${base}/sidebar/file?sessionId=foreign-session&path=${encodeURIComponent("D:/workspaces/users/other/a.txt")}`, { headers: { cookie: `dsh_session=${user!.token}` } });
    expect(foreign.status).toBe(403);
    expect(forwarded).toHaveLength(3);
  });

	it("requires a Web account before consuming a Feishu pairing link", async () => {
    const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
    const store = new MemoryAuthStore();
    const mail = new FakeMail();
    const service = new AuthService({ store, mail });
    await service.register("pair@example.com", "correct horse battery staple", "Pair User", { requestId: "test" });
    await verifyLatest(service, mail, "pair@example.com");
    const edgeConfig = config(worker.port);
    edgeConfig.pairingToken = "pairing-secret";
    const edge = createAuthEdgeServer({ config: edgeConfig, service });
    const base = await listenEdge(edge, edgeConfig);
    servers.push({ close: () => edge.close() });

    const denied = await fetch(`${base}/internal/pairing/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ openId: "ou_pair" }) });
    expect(denied.status).toBe(401);
    const sessionId = `session-${"a".repeat(64)}`;
    const malformed = await fetch(`${base}/internal/pairing/start`, { method: "POST", headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" }, body: JSON.stringify({ openId: "ou_pair", sessionId, extra: true }) });
    expect(malformed.status).toBe(400);
    const issued = await fetch(`${base}/internal/pairing/start`, { method: "POST", headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" }, body: JSON.stringify({ openId: "ou_pair", sessionId }) });
    expect(issued.status).toBe(201);
    expect([...store.pairingTokens.values()][0]?.sessionId).toBe(sessionId);
    const pairingUrl = (await issued.json() as { url: string }).url;
    expect(pairingUrl).toContain("/auth/pair?token=");

    const pairingPage = await fetch(pairingUrl);
    expect(pairingPage.status).toBe(200);
    expect(await pairingPage.text()).toContain("绑定飞书账户");
    expect([...store.pairingTokens.values()][0]?.consumedAt).toBeNull();
    const pairingCookie = firstCookie(pairingPage);
    const csrf = cookieValue(pairingCookie, "dsh_csrf");
    const paired = await fetch(`${base}/auth/pair/login`, { method: "POST", headers: { origin: base, cookie: pairingCookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ token: new URL(pairingUrl).searchParams.get("token"), email: "pair@example.com", password: "correct horse battery staple" }) });
    expect(paired.status).toBe(200);
    const sessionCookie = cookies(paired).join("; ");
    const me = await fetch(`${base}/auth/me`, { headers: { cookie: sessionCookie } });
    expect(me.status).toBe(200);
    const current = await me.json() as { user: { id: string; email: string; role: string; defaultMode: string } };
    expect(current).toMatchObject({ user: { email: "pair@example.com", role: "admin", defaultMode: "full" } });
    expect([...store.users.values()]).toHaveLength(1);
    expect(await store.findIdentity("feishu", "ou_pair")).toMatchObject({ userId: current.user.id });
    expect(await service.listResources(current.user.id, "session")).toEqual([expect.objectContaining({ resourceId: sessionId, userId: current.user.id })]);
    const boundIssued = await fetch(`${base}/internal/pairing/start`, {
      method: "POST",
      headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" },
      body: JSON.stringify({ openId: "ou_pair" }),
    });
    expect(await boundIssued.json()).toMatchObject({
      binding: { status: "bound", displayName: "Pair User", email: "pair****@example.com" },
    });
    const replay = await fetch(pairingUrl, { redirect: "manual" });
		expect(replay.status).toBe(400);
	});

	 it("continues a pairing token through email verification", async () => {
		const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
		const store = new MemoryAuthStore();
		const mail = new FakeMail();
		const service = new AuthService({ store, mail });
		const edgeConfig = config(worker.port);
		const edge = createAuthEdgeServer({ config: edgeConfig, service });
		const base = await listenEdge(edge, edgeConfig);
		servers.push({ close: () => edge.close() });

		const issued = await fetch(`${base}/internal/pairing/start`, {
			method: "POST",
			headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" },
			body: JSON.stringify({ openId: "ou_register" }),
		});
		const pairingUrl = (await issued.json() as { url: string }).url;
		const pairingToken = new URL(pairingUrl).searchParams.get("token")!;
		const pairingPage = await fetch(pairingUrl);
		const pairingCookie = firstCookie(pairingPage);
		const csrf = cookieValue(pairingCookie, "dsh_csrf");

		const register = await fetch(`${base}/auth/pair/register`, {
			method: "POST",
			headers: { origin: base, cookie: pairingCookie, "x-csrf-token": csrf, "content-type": "application/json" },
			body: JSON.stringify({ token: pairingToken, email: "registered@example.com", password: "correct horse battery staple", displayName: "Registered" }),
		});
		expect(register.status).toBe(202);
			const verified = await fetch(`${base}/auth/verify`, {
				method: "POST",
				headers: { origin: base, cookie: pairingCookie, "x-csrf-token": csrf, "content-type": "application/json" },
				body: JSON.stringify({ email: "registered@example.com", code: mail.verification.at(-1), pairingToken }),
			});
			expect(verified.status).toBe(200);
		expect(cookies(verified).some((value) => value.startsWith("dsh_session=") && value.length > "dsh_session=".length)).toBe(true);
		expect(await service.peekFeishuPairing(pairingToken)).toBeUndefined();
		expect(await store.findIdentity("feishu", "ou_register")).toMatchObject({ userId: [...store.users.values()][0]?.id });
	});

	it("does not pretend an existing account received a pairing registration email", async () => {
		const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
		const store = new MemoryAuthStore();
		const mail = new FakeMail();
		const service = new AuthService({ store, mail });
		await service.register("existing@example.com", "correct horse battery staple", "Existing", { requestId: "test" });
			await verifyLatest(service, mail, "existing@example.com");
		const edgeConfig = config(worker.port);
		const edge = createAuthEdgeServer({ config: edgeConfig, service });
		const base = await listenEdge(edge, edgeConfig);
		servers.push({ close: () => edge.close() });

		const issued = await fetch(`${base}/internal/pairing/start`, {
			method: "POST",
			headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" },
			body: JSON.stringify({ openId: "ou_existing" }),
		});
		const pairingUrl = (await issued.json() as { url: string }).url;
		const pairingPage = await fetch(pairingUrl);
		const pairingCookie = firstCookie(pairingPage);
		const response = await fetch(`${base}/auth/pair/register`, {
			method: "POST",
			headers: { origin: base, cookie: pairingCookie, "x-csrf-token": cookieValue(pairingCookie, "dsh_csrf"), "content-type": "application/json" },
			body: JSON.stringify({ token: new URL(pairingUrl).searchParams.get("token"), email: "existing@example.com", password: "correct horse battery staple", displayName: "Existing" }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "ACCOUNT_EXISTS" });
		expect(await service.peekFeishuPairing(new URL(pairingUrl).searchParams.get("token")!)).toBeTruthy();
	});

	it("requires CSRF for current-account confirmation and preserves identity conflicts", async () => {
		const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
		const store = new MemoryAuthStore();
		const mail = new FakeMail();
		const service = new AuthService({ store, mail });
		const firstRegistration = await service.register("first@example.com", "correct horse battery staple", "First", { requestId: "test" });
		expect(firstRegistration.accepted).toBe(true);
		const first = await verifyLatest(service, mail, "first@example.com");
		const edgeConfig = config(worker.port);
		const edge = createAuthEdgeServer({ config: edgeConfig, service });
		const base = await listenEdge(edge, edgeConfig);
		servers.push({ close: () => edge.close() });

		const firstIssued = await fetch(`${base}/internal/pairing/start`, {
			method: "POST",
			headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" },
			body: JSON.stringify({ openId: "ou_conflict" }),
		});
		const firstUrl = (await firstIssued.json() as { url: string }).url;
		const firstToken = new URL(firstUrl).searchParams.get("token")!;
		await expect(service.completeFeishuPairing(firstToken, first!.user.id, { requestId: "test" })).resolves.toBeTruthy();

		await service.register("second@example.com", "correct horse battery staple", "Second", { requestId: "test" });
		const second = await verifyLatest(service, mail, "second@example.com");
		const secondIssued = await fetch(`${base}/internal/pairing/start`, {
			method: "POST",
			headers: { authorization: "Bearer pairing-secret", "content-type": "application/json" },
			body: JSON.stringify({ openId: "ou_conflict" }),
		});
		const secondUrl = (await secondIssued.json() as { url: string }).url;
		const secondPage = await fetch(secondUrl, { headers: { cookie: `dsh_session=${second!.token}` } });
		const secondCookie = [`dsh_session=${second!.token}`, firstCookie(secondPage)].join("; ");
		const csrf = cookieValue(firstCookie(secondPage), "dsh_csrf");
		const missingCsrf = await fetch(`${base}/auth/pair/confirm`, {
			method: "POST",
			headers: { origin: base, cookie: secondCookie, "content-type": "application/json" },
			body: JSON.stringify({ token: new URL(secondUrl).searchParams.get("token") }),
		});
		expect(missingCsrf.status).toBe(403);
		const secondToken = new URL(secondUrl).searchParams.get("token")!;
		expect(await service.peekFeishuPairing(secondToken)).toBeTruthy();

		const conflict = await fetch(`${base}/auth/pair/confirm`, {
			method: "POST",
			headers: { origin: base, cookie: secondCookie, "x-csrf-token": csrf, "content-type": "application/json" },
			body: JSON.stringify({ token: secondToken }),
		});
		expect(conflict.status).toBe(409);
		expect(await service.peekFeishuPairing(secondToken)).toBeTruthy();
		const secondPageHtml = await secondPage.text();
		expect(secondPageHtml).toContain("切换到已绑定 Web 账户");
		expect(secondPageHtml).toContain("switch=1");

		const switchPage = await fetch(`${base}/auth/pair?token=${secondToken}&switch=1`, { headers: { cookie: secondCookie } });
		expect(switchPage.status).toBe(200);
		const switchPageHtml = await switchPage.text();
		expect(switchPageHtml).toContain("已有账户请登录");
		expect(switchPageHtml).not.toContain("确认绑定飞书账户");
		const switchCookie = secondCookie;
		const switched = await fetch(`${base}/auth/pair/login`, {
			method: "POST",
			headers: { origin: base, cookie: switchCookie, "x-csrf-token": cookieValue(switchCookie, "dsh_csrf"), "content-type": "application/json" },
			body: JSON.stringify({ token: secondToken, email: "first@example.com", password: "correct horse battery staple" }),
		});
		expect(switched.status).toBe(200);
		const switchedMe = await fetch(`${base}/auth/me`, { headers: { cookie: cookies(switched).join("; ") } });
		expect(switchedMe.status).toBe(200);
		expect(await switchedMe.json()).toMatchObject({ user: { email: "first@example.com" } });
			expect(await service.peekFeishuPairing(secondToken)).toBeUndefined();
		});

			it("serves admin users, sessions, summary and guarded management actions", async () => {
			const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
			const store = new MemoryAuthStore();
			const mail = new FakeMail();
			const service = new AuthService({ store, mail });
			await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
			const admin = await verifyLatest(service, mail, "admin@example.com");
			await service.register("member@example.com", "correct horse battery staple", "Member", { requestId: "test" });
			const member = await verifyLatest(service, mail, "member@example.com");
			const edgeConfig = config(worker.port);
			const edge = createAuthEdgeServer({ config: edgeConfig, service });
			const base = await listenEdge(edge, edgeConfig);
			servers.push({ close: () => edge.close() });

			const account = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${admin!.token}` } });
			const accountCookie = firstCookie(account);
			const sessionCookie = [`dsh_session=${admin!.token}`, accountCookie].join("; ");
			const users = await fetch(`${base}/api/admin/users`, { headers: { cookie: sessionCookie } });
			expect(users.status).toBe(200);
			const userBody = await users.json() as { users: unknown[] };
			expect(userBody).toMatchObject({ users: [expect.objectContaining({ email: "admin@example.com" }), expect.objectContaining({ email: "member@example.com" })] });
			expect(JSON.stringify(userBody)).not.toContain("tokenHash");

			const summary = await fetch(`${base}/api/admin/summary`, { headers: { cookie: sessionCookie } });
			expect(summary.status).toBe(200);
			expect(await summary.json()).toMatchObject({ users: { total: 2, admins: 1 }, sessions: { total: 2 } });

			const csrf = cookieValue(accountCookie, "dsh_csrf");
			const memberDenied = await fetch(`${base}/api/admin/users`, { headers: { cookie: `dsh_session=${member!.token}` } });
			expect(memberDenied.status).toBe(403);
			const disabled = await fetch(`${base}/api/admin/users/${member!.user.id}`, {
				method: "PATCH",
				headers: { origin: base, cookie: sessionCookie, "x-csrf-token": csrf, "content-type": "application/json" },
				body: JSON.stringify({ status: "disabled" }),
			});
				expect(disabled.status).toBe(200);
				expect(await disabled.json()).toMatchObject({ user: { status: "disabled", sessionCount: 1, workspaceCount: 0, identityCount: 0 } });

			const memberSessions = await fetch(`${base}/api/admin/sessions`, { headers: { cookie: sessionCookie } });
			const memberSession = ((await memberSessions.json()) as { sessions: Array<{ id: string; userId: string; revokedAt: string | null }> }).sessions.find((session) => session.userId === member!.user.id);
			expect(memberSession?.revokedAt).toEqual(expect.any(String));
			const bulkRevoke = await fetch(`${base}/api/admin/users/${member!.user.id}/sessions/revoke`, {
				method: "POST",
				headers: { origin: base, cookie: sessionCookie, "x-csrf-token": csrf },
			});
			expect(bulkRevoke.status).toBe(200);
			expect(await bulkRevoke.json()).toEqual({ userId: member!.user.id, revokedCount: 0 });

			const promoted = await fetch(`${base}/api/admin/users/${member!.user.id}`, {
				method: "PATCH",
				headers: { origin: base, cookie: sessionCookie, "x-csrf-token": csrf, "content-type": "application/json" },
				body: JSON.stringify({ role: "admin", status: "active" }),
			});
				expect(promoted.status).toBe(200);
				expect(await promoted.json()).toMatchObject({ user: { role: "admin", defaultMode: "full", status: "active", sessionCount: 1, workspaceCount: 0, identityCount: 0 } });

			const revoked = await fetch(`${base}/api/admin/sessions/${member!.session.id}/revoke`, {
				method: "POST",
				headers: { origin: base, cookie: sessionCookie, "x-csrf-token": csrf },
			});
			expect(revoked.status).toBe(200);
			expect(await revoked.json()).toMatchObject({ session: { id: member!.session.id, revokedAt: expect.any(String) } });

			const disabledSession = await fetch(`${base}/api/admin/users`, { headers: { cookie: `dsh_session=${member!.token}` } });
				expect(disabledSession.status).toBe(401);
			});

			it("proxies current-user billing usage to admin with the session user id", async () => {
				const worker = await listen((_req, res) => { res.writeHead(200); res.end("worker"); });
				const adminRequests: Array<{ authorization: string | undefined; userId: string | undefined }> = [];
				const admin = await listen((req, res) => {
					adminRequests.push({ authorization: header(req, "authorization"), userId: header(req, "x-dsh-auth-user-id") });
					json(res, 200, { quota: { monthlyLimitUsd: 10 }, totals: { calls: 0 }, models: [] });
				});
				const mail = new FakeMail();
				const service = new AuthService({ store: new MemoryAuthStore(), mail });
				await service.register("member@example.com", "correct horse battery staple", "Member", { requestId: "test" });
				const member = await verifyLatest(service, mail, "member@example.com");
				const edgeConfig = config(worker.port);
				edgeConfig.adminBaseUrl = `http://127.0.0.1:${admin.port}`;
				edgeConfig.adminToken = "admin-secret";
				const edge = createAuthEdgeServer({ config: edgeConfig, service });
				const base = await listenEdge(edge, edgeConfig);
				servers.push({ close: () => edge.close() });

				const response = await fetch(`${base}/api/billing/usage`, { headers: { cookie: `dsh_session=${member!.token}` } });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ quota: { monthlyLimitUsd: 10 } });
				expect(adminRequests).toEqual([{ authorization: "Bearer admin-secret", userId: JSON.stringify([member!.user.id]) }]);
			});

			it("binds Feishu OAuth callbacks to the browser state cookie and clears it", async () => {
    const provider = await listen((req, res) => {
      if (req.url === "/token") {
        void collect(req).then((body) => {
          if (body.includes('"code":"fail"')) { res.writeHead(500); res.end(); return; }
          json(res, 200, { access_token: "provider-token" });
        });
        return;
      }
      if (req.url === "/userinfo") { json(res, 200, { open_id: "ou-edge", name: "Edge User" }); return; }
      res.writeHead(404); res.end();
    });
    const worker = await listen((_req, res) => { res.writeHead(200); res.end(); });
    const edgeConfig = config(worker.port);
    edgeConfig.feishu = {
      appId: "app-id",
      appSecret: "app-secret",
      redirectUri: "",
      authorizeUrl: "https://feishu.invalid/authorize",
      tokenUrl: `http://127.0.0.1:${provider.port}/token`,
      userInfoUrl: `http://127.0.0.1:${provider.port}/userinfo`,
    };
    const edge = createAuthEdgeServer({ config: edgeConfig, service: new AuthService({ store: new MemoryAuthStore(), mail: new FakeMail() }) });
    const base = await listenEdge(edge, edgeConfig);
    edgeConfig.feishu.redirectUri = `${base}/auth/feishu/callback`;
    servers.push({ close: () => edge.close() });

    const start = await fetch(`${base}/auth/feishu/start`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const stateCookie = cookies(start).find((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
    expect(cookieValue(stateCookie, OAUTH_STATE_COOKIE)).toBe(state);

    const missingCookie = await fetch(`${base}/auth/feishu/callback?code=code&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(missingCookie.status).toBe(400);
    expect(cookies(missingCookie).some((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`) && cookieValue(value, OAUTH_STATE_COOKIE) === "")).toBe(true);

    const mismatchedCookie = await fetch(`${base}/auth/feishu/callback?code=code&state=${encodeURIComponent(state)}`, { headers: { cookie: `${OAUTH_STATE_COOKIE}=wrong-state` }, redirect: "manual" });
    expect(mismatchedCookie.status).toBe(400);
    expect(cookies(mismatchedCookie).some((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`) && cookieValue(value, OAUTH_STATE_COOKIE) === "")).toBe(true);

    const failedExchange = await fetch(`${base}/auth/feishu/callback?code=fail&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: "manual" });
    expect(failedExchange.status).toBe(500);
    expect(cookies(failedExchange).some((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`) && cookieValue(value, OAUTH_STATE_COOKIE) === "")).toBe(true);

    const callback = await fetch(`${base}/auth/feishu/callback?code=code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie }, redirect: "manual" });
    expect(callback.status).toBe(302);
    expect(cookies(callback).some((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`) && cookieValue(value, OAUTH_STATE_COOKIE) === "")).toBe(true);
  });
});

async function verifyLatest(service: AuthService, mail: FakeMail, email: string): Promise<Awaited<ReturnType<AuthService["verifyEmailCode"]>>> {
  const code = mail.verification.at(-1);
  if (!code) throw new Error(`verification code missing for ${email}`);
  return service.verifyEmailCode(email, code, { requestId: "test" });
}

it('桌面桥接在真实 Auth Edge 上遵守登录、CSRF、所有权与退出撤销', async () => {
  let forwarded = 0;
  const worker = await listen((_req, res) => { forwarded++; json(res, 200, { mode: 'cloud', connected: false }); });
  const service = new AuthService({ store: new MemoryAuthStore(), mail: new FakeMail() });
  await service.register('desktop-edge@example.com', 'correct horse battery staple', 'Desktop', { requestId: 'test' });
  const user = await service.login('desktop-edge@example.com', 'correct horse battery staple');
  await service.saveResource({ resourceType: 'session', resourceId: 'desktop-own', userId: user!.user.id, resourcePath: null, createdAt: new Date().toISOString() });
  const conf = config(worker.port); const edge = createAuthEdgeServer({ config: conf, service });
  const base = await listenEdge(edge, conf); servers.push({ close: () => edge.close() });
  const headers = { origin: base, cookie: `dsh_session=${user!.token}; dsh_csrf=fixture`, 'x-csrf-token': 'fixture', 'content-type': 'application/json' };
  const body = JSON.stringify({ action: 'status', sessionId: 'desktop-own' });
  expect((await fetch(base + '/desktop-workspace', { method: 'POST', headers: { origin: base }, body })).status).toBe(403);
  expect((await fetch(base + '/desktop-workspace', { method: 'POST', headers: { ...headers, cookie: 'dsh_csrf=fixture' }, body })).status).toBe(401);
  expect((await fetch(base + '/desktop-workspace', { method: 'POST', headers, body: JSON.stringify({ action: 'status', sessionId: 'other' }) })).status).toBe(403);
  expect((await fetch(base + '/desktop-workspace', { method: 'POST', headers, body })).status).toBe(200);
  expect(forwarded).toBe(1);
  expect((await fetch(base + '/auth/logout', { method: 'POST', headers })).ok).toBe(true);
  expect((await fetch(base + '/desktop-workspace', { method: 'POST', headers, body })).status).toBe(401);
  expect(forwarded).toBe(1);
});

function config(workerPort: number): AuthEdgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    workerBaseUrl: `http://127.0.0.1:${workerPort}`,
    publicOrigin: "http://127.0.0.1:0",
    workerToken: "worker-secret",
    databaseUrl: "postgres://unused",
    userModelEncryptionKey: "A".repeat(43),
    trustedOrigins: ["http://127.0.0.1:0"],
    sessionCookieSecure: false,
    userWorkspaceRoot: "D:/workspaces/users",
    adminWorkspaceRoot: "D:/workspaces/admin",
    requestBodyLimit: 128 * 1024,
    promptAudit: { enabled: false, timeoutMs: 1000, maxConcurrent: 2 },
    mail: { mode: "console", port: 465, secure: true },
    pairingToken: "pairing-secret",
  };
}

function parseBootManifest(html: string): {
  entries: Array<{ id?: unknown }>;
  batches?: Array<{ entries?: unknown[]; [key: string]: unknown }>;
} {
  const prefix = 'globalThis["__DSH_BOOT__"] = ';
  const start = html.indexOf(prefix);
  if (start < 0) throw new Error("boot manifest missing");
  const valueStart = start + prefix.length;
  const scriptEnd = html.indexOf("</script>", valueStart);
  if (scriptEnd < 0) throw new Error("boot manifest script missing");
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/, "");
  const parsed = JSON.parse(source) as { entries?: unknown; batches?: unknown };
  if (!Array.isArray(parsed.entries)) throw new Error("boot manifest entries missing");
  const batches = Array.isArray(parsed.batches)
    ? parsed.batches.filter((batch): batch is { entries?: unknown[]; [key: string]: unknown } => typeof batch === "object" && batch !== null)
    : undefined;
  return {
    entries: parsed.entries.filter((entry): entry is { id?: unknown } => typeof entry === "object" && entry !== null),
    ...(batches === undefined ? {} : { batches }),
  };
}

async function listenEdge(edge: ReturnType<typeof createAuthEdgeServer>, config: AuthEdgeConfig): Promise<string> {
  await edge.listen();
  const address = edge.server.address();
  if (!address || typeof address === "string") throw new Error("edge test server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  config.publicOrigin = base;
  config.trustedOrigins = [base];
  return base;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, onScope?: (binding: Record<string, unknown>) => void): Promise<Server & { port: number }> {
  const server = createServer((req, res) => {
    if (handleWorkerAuthBridge(req, res, onScope)) return;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const result = Object.assign(server, { port: address.port });
  servers.push({ close: () => new Promise<void>((resolve) => result.close(() => resolve())) });
  return result;
}

function handleWorkerAuthBridge(req: IncomingMessage, res: ServerResponse, onScope?: (binding: Record<string, unknown>) => void): boolean {
  if (req.method === "POST" && req.url === "/internal/web-auth/session") {
    json(res, 200, { url: `http://${req.headers.host}/?token=test` });
    return true;
  }
  if (req.method === "POST" && req.url === "/internal/web-auth/scope") {
    void collect(req).then((body) => {
      onScope?.(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(204);
      res.end();
    });
    return true;
  }
  if (req.method === "GET" && req.url === "/?token=test") {
    res.writeHead(303, { location: "/", "set-cookie": "dsh_worker=test; HttpOnly; SameSite=Strict" });
    res.end();
    return true;
  }
  return false;
}

function header(req: IncomingMessage, name: string): string | undefined { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function collect(req: IncomingMessage): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
function json(res: ServerResponse, status: number, body: unknown): void { const value = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(value) }); res.end(value); }
function cookies(response: Response): string[] { return typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!) : [response.headers.get("set-cookie")?.split(",", 1)[0] ?? ""]; }
function firstCookie(response: Response): string { return cookies(response).join("; "); }
function cookieValue(cookie: string, name: string): string { return decodeURIComponent(cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? ""); }
