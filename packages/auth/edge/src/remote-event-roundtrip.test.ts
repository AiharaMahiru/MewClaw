import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { once, type EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthService, MemoryAuthStore } from "dsh-lark-auth";
import { createAuthEdgeServer } from "./server.js";
import type { AuthEdgeConfig } from "./config.js";

// 使用已锁定Gateway依赖的真实ws，不自造帧解析器或心跳实现。
interface Socket extends EventEmitter { send(data: string): void; ping(): void; terminate(): void; readyState: number }
interface Acceptor { handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: Socket) => void): void; close(): void }
const require = createRequire(import.meta.url);
const WebSocket = createRequire(require.resolve("@deepseek-ai/dsh-api-gateway/package.json"))("ws") as {
  new(url: string, options: { headers: Record<string, string> }): Socket;
  WebSocketServer: new(options: { noServer: boolean }) => Acceptor;
};

describe("真实HTTP/WebSocket选项回传与持续连接", () => {
  it.each(["admin", "user"])("%s连续回答12次、保留心跳且跨用户/重放拒绝", async role => {
    const workspace = await mkdtemp(join(tmpdir(), "dsh-event-roundtrip-"));
    const codes: string[] = [];
    const service = new AuthService({ store: new MemoryAuthStore(), mail: {
      sendVerification: async input => { codes.push(input.code); }, sendPasswordReset: async () => {},
    } });
    const sessions = [];
    for (const email of ["admin@test.invalid", "user@test.invalid", "foreign@test.invalid"]) {
      await service.register(email, "correct horse battery staple", email, { requestId: "test" });
      sessions.push((await service.verifyEmailCode(email, codes.at(-1)!, { requestId: "test" }))!);
    }
    const current = sessions[role === "admin" ? 0 : 1]!;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: current.user.id, resourcePath: null, createdAt: new Date().toISOString() });
    let forwards = 0;
    let pongs = 0;
    let peer: Socket | undefined;
    const acceptor = new WebSocket.WebSocketServer({ noServer: true });
    const worker = createServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const chunk of req) raw += String(chunk);
        const request = JSON.parse(raw);
        expect(req.url).toBe("/api/$events/result");
        expect(request.type).toBe("client-request");
        expect(request.rpcId).toBe(request.payload.args.eventId);
        expect(request.payload.args.outcome).toEqual({ kind: "result", value: { choice: "A" } });
        forwards++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: null } }));
      })().catch(() => { res.writeHead(500); res.end(); });
    });
    const send = (value: unknown) => peer!.send(JSON.stringify({ type: "item", streamId: "events", value }));
    worker.on("upgrade", (req, socket, head) => acceptor.handleUpgrade(req, socket, head, ws => {
      peer = ws;
      ws.on("pong", () => { pongs++; });
      ws.once("message", () => send({ type: "ready", clientId: "client-live", host: { home: workspace } }));
    }));
    await new Promise<void>(resolve => worker.listen(0, "127.0.0.1", resolve));
    const workerAddress = worker.address();
    if (!workerAddress || typeof workerAddress === "string") throw new Error("worker address");
    const config = {
      host: "127.0.0.1", port: 0, workerBaseUrl: `http://127.0.0.1:${workerAddress.port}`,
      publicOrigin: "http://127.0.0.1", trustedOrigins: [], sessionCookieSecure: false,
      requestBodyLimit: 128 * 1024, userWorkspaceRoot: join(workspace, "users"), adminWorkspaceRoot: join(workspace, "admin"),
      userModelEncryptionKey: "A".repeat(43), databaseUrl: "postgres://synthetic-test",
      mail: { mode: "console", port: 465, secure: true },
      promptAudit: { enabled: true, timeoutMs: 1000, maxConcurrent: 2 },
    } satisfies AuthEdgeConfig;
    const edge = createAuthEdgeServer({ config, service, promptAuditor: { audit: async () => { throw new Error("选项结果不应调用提示词审计"); } } });
    await edge.listen();
    const address = edge.server.address();
    if (!address || typeof address === "string") throw new Error("edge address");
    const base = `http://127.0.0.1:${address.port}`;
    config.publicOrigin = base;
    (config.trustedOrigins as string[]).push(base);
    const cookie = (token: string) => `dsh_session=${token}; dsh_csrf=roundtrip`;
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/remote.mux`, { headers: { origin: base, cookie: cookie(current.token) } });
    const post = (eventId: string, token = current.token, csrf = "roundtrip") => fetch(`${base}/api/$events/result`, {
      method: "POST", headers: { origin: base, cookie: cookie(token), "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: eventId, method: "$events/result", payload: { args: { clientId: "client-live", eventId, outcome: { kind: "result", value: { choice: "A" } } } } }),
    });
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      await once(socket, "open");
      const ready = once(socket, "message");
      socket.send(JSON.stringify({ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } }));
      await ready;
      heartbeat = setInterval(() => { if (peer?.readyState === 1) peer.ping(); }, 100);
      for (let index = 0; index < 12; index++) {
        const eventId = `question-${index}`;
        const delivered = once(socket, "message");
        send({ type: "waterfall", event: index % 2 ? "approval/request" : "user-questions/request", eventId, agentId: "own-session", request: { message: "选择A或B" } });
        await delivered;
        if (index === 0) {
          expect((await post(eventId, sessions[2]!.token)).status).toBe(403);
          expect((await post(eventId, current.token, "wrong-csrf")).status).toBe(403);
          expect(forwards).toBe(0);
        }
        const response = await post(eventId);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ type: "server-response", rpcId: eventId, result: { ok: true, value: null } });
        expect((await post(eventId)).status).toBe(403);
        expect(socket.readyState).toBe(1);
      }
      await new Promise(resolve => setTimeout(resolve, 6500));
      expect(pongs).toBeGreaterThan(10);
      expect(forwards).toBe(12);
      expect(socket.readyState).toBe(1);
      expect(socket.listenerCount("message")).toBe(0);
      const pending = once(socket, "message");
      send({ type: "waterfall", event: "user-questions/request", eventId: "stale", agentId: "own-session", request: {} });
      await pending;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect((await post("stale")).status).toBe(403);
    } finally {
      clearInterval(heartbeat);
      socket.terminate();
      peer?.terminate();
      await edge.close();
      acceptor.close();
      await new Promise<void>(resolve => worker.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
