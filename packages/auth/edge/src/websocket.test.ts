import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { AuthService, MemoryAuthStore, type MailSender } from "dsh-lark-auth";

import { createAuthEdgeServer } from "./server.js";
import type { AuthEdgeConfig } from "./config.js";

const SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 5_000;

class FakeMail implements MailSender {
  readonly verification: string[] = [];
  async sendVerification(input: { to: string; displayName: string; code: string; expiresInMinutes: number }): Promise<void> { this.verification.push(input.code); }
  async sendPasswordReset(): Promise<void> {}
}

describe("AuthEdgeServer WebSocket isolation", () => {
  it("does not forward a foreign session/event frame to a normal user", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("user@example.com", "correct horse battery staple", "User", { requestId: "test" });
    const userResult = await service.verifyEmailCode("user@example.com", mail.verification[1]!, { requestId: "test" });
    const user = userResult!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });

    const worker = createServer(workerAuthBridge);
    let upstreamOrigin: string | undefined;
    worker.on("upgrade", (request, socket) => {
      upstreamOrigin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(textFrame(envelope("own-session")));
      socket.write(textFrame(envelope("foreign-session")));
      socket.end();
    });
    await listen(worker);

    const config = edgeConfig(workerPort(worker));
    const edge = createAuthEdgeServer({ config, service });
    await edge.listen();
    const edgeAddress = edge.server.address();
    if (!edgeAddress || typeof edgeAddress === "string") throw new Error("edge server did not bind");
    const origin = `http://127.0.0.1:${edgeAddress.port}`;
    config.publicOrigin = origin;
    config.trustedOrigins = [origin];

    const frames = await readFrames(edgeAddress.port, userResult!.token, origin);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!).payload.sessionId).toBe("own-session");
    expect(upstreamOrigin).toBe(`http://127.0.0.1:${workerPort(worker)}`);
    await edge.close();
    await close(worker);
  });

  it("forwards Remote mux transport and generation ready frames for a normal user", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("remote@example.com", "correct horse battery staple", "Remote User", { requestId: "test" });
    const userResult = await service.verifyEmailCode("remote@example.com", mail.verification[1]!, { requestId: "test" });
    const user = userResult!.user;
    await service.saveResource({ resourceType: "session", resourceId: "own-session", userId: user.id, resourcePath: `D:/workspaces/users/${user.id}`, createdAt: "2026-08-19T00:00:00.000Z" });

    const worker = createServer(workerAuthBridge);
    worker.on("upgrade", (_request, socket) => {
      const key = _request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.once("data", () => {
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "events", value: { type: "ready", clientId: "client-1", host: { home: "/var/lib/dsh" } } })));
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "rpc", value: { type: "ready", clientId: "fake-client", host: { home: "/var/lib/dsh" } } })));
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "rpc", value: { type: "workspace/list", items: [{ workspaceId: "foreign" }] } })));
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "rpc", value: { type: "emit", event: "api-session/status", args: ["foreign-session", true] } })));
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "events", value: { type: "emit", event: "api-session/status", args: ["own-session", true] } })));
        socket.write(textFrame(JSON.stringify({ type: "item", streamId: "events", value: { type: "emit", event: "api-session/status", args: ["foreign-session", true] } })));
        socket.write(textFrame(JSON.stringify({ type: "end", streamId: "events" })));
        socket.write(textFrame(JSON.stringify({ type: "end", streamId: "rpc" })));
        socket.end();
      });
      socket.resume();
    });
    await listen(worker);

    const config = edgeConfig(workerPort(worker));
    const edge = createAuthEdgeServer({ config, service });
    await edge.listen();
    const edgeAddress = edge.server.address();
    if (!edgeAddress || typeof edgeAddress === "string") throw new Error("edge server did not bind");
    const origin = `http://127.0.0.1:${edgeAddress.port}`;
    config.publicOrigin = origin;
    config.trustedOrigins = [origin];

    const frames = await readFrames(edgeAddress.port, userResult!.token, origin, "/api/remote.mux", [
      maskedTextFrame(JSON.stringify({ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } })),
      maskedTextFrame(JSON.stringify({ type: "open", streamId: "rpc", endpoint: "session/follow", payload: { args: {} } })),
    ]);
    expect(frames).toHaveLength(7);
    expect(JSON.parse(frames[0]!).value.type).toBe("ready");
    expect(JSON.parse(frames[1]!).value.type).toBe("ready");
    expect(JSON.parse(frames[2]!).value.type).toBe("workspace/list");
    expect(JSON.parse(frames[3]!).value.args).toEqual(["foreign-session", true]);
    expect(JSON.parse(frames[4]!).value.args).toEqual(["own-session", true]);
    expect(JSON.parse(frames[5]!)).toMatchObject({ type: "end", streamId: "events" });
    expect(JSON.parse(frames[6]!)).toMatchObject({ type: "end", streamId: "rpc" });
    await edge.close();
    await close(worker);
  });

  it("forwards an owned better-sidebar terminal list socket", async () => {
    const mail = new FakeMail();
    const store = new MemoryAuthStore();
    const service = new AuthService({ store, mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    await service.register("sidebar@example.com", "correct horse battery staple", "Sidebar User", { requestId: "test" });
    const user = await service.verifyEmailCode("sidebar@example.com", mail.verification[1]!, { requestId: "test" });
    await service.saveResource({ resourceType: "session", resourceId: "sidebar-session", userId: user!.user.id, resourcePath: "D:/workspaces/users/sidebar", createdAt: "2026-08-20T00:00:00.000Z" });

    const worker = createServer(workerAuthBridge);
    const upstreamPaths: string[] = [];
    worker.on("upgrade", (request, socket) => {
      if (request.url) upstreamPaths.push(request.url);
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.end();
    });
    await listen(worker);

    const config = edgeConfig(workerPort(worker));
    const edge = createAuthEdgeServer({ config, service });
    await edge.listen();
    const edgeAddress = edge.server.address();
    if (!edgeAddress || typeof edgeAddress === "string") throw new Error("edge server did not bind");
    const origin = `http://127.0.0.1:${edgeAddress.port}`;
    config.publicOrigin = origin;
    config.trustedOrigins = [origin];

    for (const endpoint of ["/sidebar/ws/agent-terminals", "/sidebar/ws/agent-opens"]) {
      const frames = await readFrames(edgeAddress.port, user!.token, origin, `${endpoint}?sessionId=sidebar-session`);
      expect(frames).toEqual([]);
    }
    expect(upstreamPaths).toEqual([
      "/sidebar/ws/agent-terminals?sessionId=sidebar-session",
      "/sidebar/ws/agent-opens?sessionId=sidebar-session",
    ]);
    await edge.close();
    await close(worker);
  });

  it("closes both event streams and their upstream sockets during shutdown", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const admin = await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    const upstreamSockets = new Set<Duplex>();
    const worker = createServer(workerAuthBridge);
    worker.on("upgrade", (request, socket) => {
      upstreamSockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", () => upstreamSockets.delete(socket));
      const key = request.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.resume();
      socket.once("end", () => socket.destroy());
    });
    await listen(worker);
    const config = edgeConfig(workerPort(worker));
    const edge = createAuthEdgeServer({ config, service });
    await edge.listen();
    const address = edge.server.address();
    if (!address || typeof address === "string") throw new Error("edge server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    config.publicOrigin = origin;
    config.trustedOrigins = [origin];
    const clients: Socket[] = [];
    let closePromise: Promise<void> | undefined;
    try {
      clients.push(...await Promise.all([
        openWebSocket(address.port, admin!.token, origin, "/api/events.mux"),
        openWebSocket(address.port, admin!.token, origin, "/api/events.host"),
      ]));
      expect(upstreamSockets.size).toBe(2);
      const socketsClosed = Promise.all([...clients, ...upstreamSockets].map((socket) => socketClosed(socket)));
      closePromise = edge.close();
      expect(await settlesWithin(closePromise, SOCKET_CLOSE_TIMEOUT_MS)).toBe(true);
      expect(upstreamSockets.size).toBe(0);
      expect({
        allClosed: await settlesWithin(socketsClosed, SOCKET_CLOSE_TIMEOUT_MS),
        clientDestroyed: clients.map((socket) => socket.destroyed),
        upstreamCount: upstreamSockets.size,
      }).toEqual({ allClosed: true, clientDestroyed: [true, true], upstreamCount: 0 });
    } finally {
      for (const socket of clients) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      if (closePromise) await closePromise;
      else await edge.close();
      await close(worker);
    }
  });

  it("does not connect upstream after shutdown interrupts pending authentication", async () => {
    const mail = new FakeMail();
    const service = new AuthService({ store: new MemoryAuthStore(), mail });
    await service.register("admin@example.com", "correct horse battery staple", "Admin", { requestId: "test" });
    const admin = await service.verifyEmailCode("admin@example.com", mail.verification[0]!, { requestId: "test" });
    const originalCurrent = service.current.bind(service);
    let releaseCurrent!: () => void;
    let markCurrentStarted!: () => void;
    const currentStarted = new Promise<void>((resolve) => { markCurrentStarted = resolve; });
    const currentAllowed = new Promise<void>((resolve) => { releaseCurrent = resolve; });
    vi.spyOn(service, "current").mockImplementation(async (token, requestMetadata) => {
      markCurrentStarted();
      await currentAllowed;
      return originalCurrent(token, requestMetadata);
    });
    let workerConnections = 0;
    const worker = createServer(workerAuthBridge);
    worker.on("connection", (socket) => { workerConnections += 1; socket.destroy(); });
    await listen(worker);
    const config = edgeConfig(workerPort(worker));
    const edge = createAuthEdgeServer({ config, service });
    await edge.listen();
    const address = edge.server.address();
    if (!address || typeof address === "string") throw new Error("edge server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    config.publicOrigin = origin;
    config.trustedOrigins = [origin];
    const client = await startWebSocketRequest(address.port, admin!.token, origin);
    try {
      await currentStarted;
      expect(await settlesWithin(edge.close(), SOCKET_CLOSE_TIMEOUT_MS)).toBe(true);
      releaseCurrent();
      await delay(100);
      expect(workerConnections).toBe(0);
    } finally {
      releaseCurrent();
      client.destroy();
      await edge.close();
      await close(worker);
      vi.restoreAllMocks();
    }
  });
});

function edgeConfig(workerPortValue: number): AuthEdgeConfig {
  return {
    host: "127.0.0.1", port: 0, workerBaseUrl: `http://127.0.0.1:${workerPortValue}`, publicOrigin: "http://127.0.0.1:0", workerToken: "worker-secret", databaseUrl: "postgres://unused", userModelEncryptionKey: "A".repeat(43), trustedOrigins: ["http://127.0.0.1:0"], sessionCookieSecure: false, userWorkspaceRoot: "D:/workspaces/users", adminWorkspaceRoot: "D:/workspaces/admin", requestBodyLimit: 128 * 1024, mail: { mode: "console", port: 465, secure: true },
  };
}

function workerAuthBridge(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === "POST" && req.url === "/internal/web-auth/session") {
    const value = JSON.stringify({ url: `http://${req.headers.host}/?token=test` });
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(value) });
    res.end(value);
    return;
  }
  if (req.method === "GET" && req.url === "/?token=test") {
    res.writeHead(303, { location: "/", "set-cookie": "dsh_worker=test; HttpOnly; SameSite=Strict" });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
}

async function listen(server: Server): Promise<void> { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function workerPort(server: Server): number { const address = server.address(); if (!address || typeof address === "string") throw new Error("worker server did not bind"); return address.port; }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }

function readFrames(port: number, sessionToken: string, origin: string, path = "/api/events.mux", clientFrames: Buffer[] = []): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let clientFramesSent = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket test timeout")); }, 5_000);
    socket.on("connect", () => {
      const key = Buffer.from("auth-edge-test").toString("base64");
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: dsh_session=${sessionToken}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (!clientFramesSent && clientFrames.length > 0 && Buffer.concat(chunks).includes(Buffer.from("\r\n\r\n"))) {
        clientFramesSent = true;
        socket.write(Buffer.concat(clientFrames));
      }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("close", () => { clearTimeout(timer); try { resolve(parseFrames(Buffer.concat(chunks))); } catch (error) { reject(error); } });
  });
}

function openWebSocket(port: number, sessionToken: string, origin: string, path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("WebSocket handshake timeout")); }, WEBSOCKET_HANDSHAKE_TIMEOUT_MS);
    socket.on("error", reject);
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      const marker = response.indexOf(Buffer.from("\r\n\r\n"));
      if (marker < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const status = response.subarray(0, marker).toString("ascii").split("\r\n", 1)[0];
      if (!status?.includes(" 101 ")) { socket.destroy(); reject(new Error(`WebSocket handshake failed: ${status}`)); return; }
      resolve(socket);
    };
    socket.on("data", onData);
    socket.on("connect", () => {
      const key = Buffer.from(`auth-edge-${path}`).toString("base64");
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: dsh_session=${sessionToken}\r\n\r\n`);
    });
  });
}

function startWebSocketRequest(port: number, sessionToken: string, origin: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      const key = Buffer.from("auth-edge-pending").toString("base64");
      socket.write(`GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: dsh_session=${sessionToken}\r\n\r\n`);
      resolve(socket);
    });
  });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

function socketClosed(socket: Duplex): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function parseFrames(buffer: Buffer): string[] {
  const marker = buffer.indexOf(Buffer.from("\r\n\r\n"));
  if (marker < 0) throw new Error("missing WebSocket handshake");
  const output: string[] = [];
  let offset = marker + 4;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const marker = second & 0x7f;
    const headerLength = marker < 126 ? 2 : marker === 126 ? 4 : 10;
    if ((second & 0x80) !== 0 || marker === 127 || offset + headerLength > buffer.length) throw new Error("unexpected test frame");
    const length = marker === 126 ? buffer.readUInt16BE(offset + 2) : marker;
    const payloadStart = offset + headerLength;
    if (payloadStart + length > buffer.length) throw new Error("unexpected test frame");
    if ((first & 0x0f) === 0x1) output.push(buffer.subarray(payloadStart, payloadStart + length).toString("utf8"));
    offset = payloadStart + length;
  }
  return output;
}

function textFrame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); return Buffer.concat([header, payload]);
}
function maskedTextFrame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  if (payload.length >= 126) throw new Error("test frame is unexpectedly large");
  const mask = Buffer.from([1, 2, 3, 4]);
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) encoded[index] = encoded[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, encoded]);
}
function envelope(sessionId: string): string { return JSON.stringify({ type: "server-request", rpcId: "test", method: "events.mux", payload: { type: "session/event", sessionId, event: { type: "user/message" } } }); }
