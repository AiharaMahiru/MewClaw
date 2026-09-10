import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomInt } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthService, MemoryAuthStore, type MailSender } from "dsh-lark-auth";

import { createAuthEdgeServer } from "./server.js";
import type { AuthEdgeConfig } from "./config.js";

class TestMail implements MailSender {
  readonly verification: string[] = [];
  async sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void> { this.verification.push(input.code); }
  async sendPasswordReset(): Promise<void> { return undefined; }
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); });

describe("authenticated workspace isolation", () => {
  it("provisions multiple user roots and isolates directory, workspace, session and preset access", async () => {
    const userBase = await mkdtemp(join(tmpdir(), "dsh-users-"));
    const adminBase = await mkdtemp(join(tmpdir(), "dsh-admin-"));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let workspaces: Array<Record<string, unknown>> = [];
    const worker = await listenWorker(async (req, res) => {
      if (req.method !== "POST") { res.writeHead(200, { "content-type": "text/html" }); res.end("worker"); return; }
      const body = JSON.parse(await collect(req)) as Record<string, unknown>;
      requests.push({ path: req.url ?? "", body });
      const args = rpcArgs(body);
      if (req.url === "/api/host.createDirectory") {
        const path = join(String(args.path), String(args.name));
        await mkdir(path, { recursive: false });
        json(res, { result: { value: { path } } });
        return;
      }
      if (req.url === "/api/host.listDirectory") {
        json(res, { result: { value: { path: String(args.path), home: "worker-home", crumbs: [{ name: "root", path: String(args.path) }], entries: [], truncated: false } } });
        return;
      }
      if (req.url === "/api/workspace.create") {
        const workspace = { ...workspaces.find((item) => item.workspaceId === (args.workspaceId ?? "")) ?? workspaces[0]!, path: String(args.path), sessionIds: [] };
        json(res, { result: { value: { workspace, created: true } } });
        return;
      }
      if (req.url === "/api/workspace.list") {
        json(res, { result: { value: { items: workspaces, archivedSessionIds: [] } } });
        return;
      }
      if (req.url === "/api/session.create") {
        json(res, { result: { value: { sessionId: "session-alice" } } });
        return;
      }
      json(res, { result: { value: {} } });
    });
    const mail = new TestMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    const admin = await registerAndVerify(service, mail, "admin@example.com", "Admin");
    const alice = await registerAndVerify(service, mail, "alice@example.com", "Alice");
    const bob = await registerAndVerify(service, mail, "bob@example.com", "Bob");
    workspaces = [
      makeWorkspace("ws-alice", join(userBase, alice.user.id), "Alice"),
      makeWorkspace("ws-bob", join(userBase, bob.user.id), "Bob"),
    ];
    const config = edgeConfig(worker.port, userBase, adminBase);
    const edge = await listenEdge(config, service);
    const address = edge.server.address();
    if (!address || typeof address === "string") throw new Error("edge did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    config.publicOrigin = base;
    config.trustedOrigins = [base];
    servers.push({ close: () => edge.close() });
    const aliceCsrf = await issueCsrf(base, alice.token);
    const bobCsrf = await issueCsrf(base, bob.token);
    const adminCsrf = await issueCsrf(base, admin.token);

    const aliceRoot = join(userBase, alice.user.id);
    const aliceProject = join(aliceRoot, "project");
    const listed = await callRpc(base, alice.token, aliceCsrf, "host.listDirectory", {});
    expect(listed.response.status).toBe(200);
    expect(rpcArgs(lastRequest(requests, "/api/host.listDirectory").body).path).toBe(aliceRoot);
    expect(await exists(aliceRoot)).toBe(true);

    const created = await callRpc(base, alice.token, aliceCsrf, "host.createDirectory", { path: aliceRoot, name: "project" });
    expect(created.response.status).toBe(200);
    expect(await exists(aliceProject)).toBe(true);
    const workspace = await callRpc(base, alice.token, aliceCsrf, "workspace.create", { path: aliceProject });
    expect(workspace.response.status).toBe(200);
    expect(await service.findResource("workspace", "ws-alice")).toMatchObject({ userId: alice.user.id, resourcePath: aliceProject });
    const ownGit = await callGit(base, alice.token, aliceCsrf, aliceProject);
    expect(ownGit.status).toBe(200);
    const gitRequests = requests.filter((item) => item.path === "/git/status").length;
    const foreignGit = await callGit(base, bob.token, bobCsrf, aliceProject);
    expect(foreignGit.status).toBe(403);
    expect(requests.filter((item) => item.path === "/git/status")).toHaveLength(gitRequests);
    expect((await callGit(base, admin.token, adminCsrf, aliceProject)).status).toBe(200);
    expect((await fetch(`${base}/git/events?path=${encodeURIComponent(aliceProject)}`, {
      headers: { cookie: `dsh_session=${bob.token}` },
    })).status).toBe(403);
    const session = await callRpc(base, alice.token, aliceCsrf, "session.create", { cwd: aliceProject });
    expect(session.response.status).toBe(200);
    expect(rpcArgs(lastRequest(requests, "/api/session.create").body)).toMatchObject({ cwd: aliceProject, agentPreset: "lark-lightweight" });

    // 通过实际 HTTP 代理验证新版预设选择，以及越权请求不会到达 Worker。
    const presetArgs = { agentId: "session-alice", agentPreset: "standard" };
    const selected = await callRpc(base, alice.token, aliceCsrf, "agentPresets/select", presetArgs);
    expect(selected.response.status).toBe(200);
    expect(rpcArgs(lastRequest(requests, "/api/agentPresets/select").body)).toEqual(presetArgs);
    const foreignPreset = await callRpc(base, bob.token, bobCsrf, "agentPresets/select", presetArgs);
    expect(foreignPreset.response.status).toBe(403);
    const invalidPreset = await callRpc(base, alice.token, aliceCsrf, "agentPresets/select", { ...presetArgs, agentPreset: "../../private" });
    expect(invalidPreset.response.status).toBe(403);
    expect(requests.filter((item) => item.path === "/api/agentPresets/select")).toHaveLength(1);

    const bobList = await callRpc(base, bob.token, bobCsrf, "workspace.list", {});
    expect(bobList.response.status).toBe(200);
    expect((bobList.body.result as { value: { items: Array<{ workspaceId: string }> } }).value.items.map((item) => item.workspaceId)).toEqual(["ws-bob"]);
    const foreignSession = await callRpc(base, bob.token, bobCsrf, "session.history", { sessionId: "session-alice" });
    expect(foreignSession.response.status).toBe(403);
    const full = await callRpc(base, bob.token, bobCsrf, "session.create", { agentPreset: "lark-standard" });
    expect(full.response.status).toBe(200);
    const outside = await callRpc(base, bob.token, bobCsrf, "host.createDirectory", { path: aliceRoot, name: "intrusion" });
    expect(outside.response.status).toBe(403);
    const adminSession = await callRpc(base, admin.token, adminCsrf, "session.create", { agentPreset: "lark-standard" });
    expect(adminSession.response.status).toBe(200);
    expect(rpcArgs(lastRequest(requests, "/api/session.create").body).agentPreset).toBe("lark-standard");
    expect(await exists(join(adminBase, admin.user.id))).toBe(true);
    expect(requests.filter((item) => item.path === "/api/host.createDirectory")).toHaveLength(1);
    await rm(userBase, { recursive: true, force: true });
    await rm(adminBase, { recursive: true, force: true });
  });
});

async function registerAndVerify(service: AuthService, mail: TestMail, email: string, displayName: string) {
  await service.register(email, "correct horse battery staple", displayName, { requestId: "workspace-test" });
  const result = await service.verifyEmailCode(email, mail.verification.at(-1)!, { requestId: "workspace-test" });
  if (!result) throw new Error(`verification failed for ${email}`);
  return result;
}

function makeWorkspace(workspaceId: string, path: string, title: string): Record<string, unknown> {
  return { workspaceId, path, title, sessionIds: [], createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
}

function edgeConfig(workerPort: number, userBase: string, adminBase: string): AuthEdgeConfig {
  return { host: "127.0.0.1", port: 0, workerBaseUrl: `http://127.0.0.1:${workerPort}`, publicOrigin: "http://127.0.0.1:0", workerToken: "worker-secret", databaseUrl: "postgres://unused", userModelEncryptionKey: "A".repeat(43), trustedOrigins: ["http://127.0.0.1:0"], sessionCookieSecure: false, userWorkspaceRoot: userBase, adminWorkspaceRoot: adminBase, requestBodyLimit: 128 * 1024, mail: { mode: "console", port: 465, secure: true } };
}

async function issueCsrf(base: string, token: string): Promise<string> {
  const response = await fetch(`${base}/auth/account`, { redirect: "manual", headers: { cookie: `dsh_session=${token}` } });
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const csrf = cookies.map((value) => value.split(";", 1)[0]!).find((value) => value.startsWith("dsh_csrf="));
  if (!csrf) throw new Error("csrf cookie missing");
  return decodeURIComponent(csrf.slice("dsh_csrf=".length));
}

async function listenEdge(config: AuthEdgeConfig, service: AuthService): Promise<ReturnType<typeof createAuthEdgeServer>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // Node Fetch 会拒绝部分低位端口；使用无禁用项的测试区间，并处理并发占用。
    config.port = randomInt(20_000, 30_000);
    const edge = createAuthEdgeServer({ config, service });
    try {
      await edge.listen();
      return edge;
    } catch (error) {
      await edge.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("unable to bind auth edge test port");
}

async function callRpc(base: string, token: string, csrf: string, method: string, args: Record<string, unknown>): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/api/${method}`, { method: "POST", headers: { origin: base, cookie: `dsh_session=${token}; dsh_csrf=${encodeURIComponent(csrf)}`, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ method, payload: { args } }) });
  const body = await response.json() as Record<string, unknown>;
  return { response, body };
}

async function callGit(base: string, token: string, csrf: string, path: string): Promise<Response> {
  return fetch(`${base}/git/status`, {
    method: "POST",
    headers: {
      origin: base,
      cookie: `dsh_session=${token}; dsh_csrf=${encodeURIComponent(csrf)}`,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
}

function rpcArgs(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload;
  if (!payload || typeof payload !== "object") return {};
  const args = (payload as Record<string, unknown>).args;
  return args && typeof args === "object" ? args as Record<string, unknown> : payload as Record<string, unknown>;
}

function lastRequest(requests: Array<{ path: string; body: Record<string, unknown> }>, path: string): { path: string; body: Record<string, unknown> } {
  const request = [...requests].reverse().find((item) => item.path === path);
  if (!request) throw new Error(`missing worker request ${path}`);
  return request;
}

async function exists(path: string): Promise<boolean> { try { await mkdir(path, { recursive: false }); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST"; } }
async function collect(req: IncomingMessage): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
function json(res: ServerResponse, body: unknown): void { const value = JSON.stringify(body); res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(value) }); res.end(value); }
async function listenWorker(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Server & { port: number }> { const server = createServer((req, res) => { if (handleWorkerAuthBridge(req, res)) return; void handler(req, res); }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("worker did not bind"); const result = Object.assign(server, { port: address.port }); servers.push({ close: () => new Promise<void>((resolve) => result.close(() => resolve())) }); return result; }
function handleWorkerAuthBridge(req: IncomingMessage, res: ServerResponse): boolean { if (req.method === "POST" && req.url === "/internal/web-auth/session") { const value = JSON.stringify({ url: `http://${req.headers.host}/?token=test` }); res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(value) }); res.end(value); return true; } if (req.method === "POST" && req.url === "/internal/web-auth/scope") { req.resume(); res.writeHead(204); res.end(); return true; } if (req.method === "GET" && req.url === "/?token=test") { res.writeHead(303, { location: "/", "set-cookie": "dsh_worker=test; HttpOnly; SameSite=Strict" }); res.end(); return true; } return false; }
