import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AuthService, MemoryAuthStore, type MailSender } from "dsh-lark-auth";

import type { AuthEdgeConfig } from "./config.js";
import { createAuthEdgeServer } from "./server.js";

class FakeMail implements MailSender {
  async sendVerification(): Promise<void> {}
  async sendPasswordReset(): Promise<void> {}
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe("Auth Edge 公共 share 分流", () => {
  it("在登录和 CSRF 前流式代理 HTTP/API，并清除平台身份凭证", async () => {
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let observed!: {
      method: string | undefined;
      path: string | undefined;
      body: string;
      headers: IncomingMessage["headers"];
    };
    const preview = await listen(async (req, res) => {
      observed = {
        method: req.method,
        path: req.url,
        body: await collect(req),
        headers: req.headers,
      };
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-security-policy": "default-src *",
        "strict-transport-security": "max-age=0",
        "x-content-type-options": "preview-value",
      });
      res.write("data: first\n\n");
      await responseReleased;
      res.end("data: second\n\n");
    });
    const worker = await listen((_req, res) => res.end("worker"));
    const { edge, base } = await listenEdge(worker.port, preview.port);

    const responsePromise = fetch(`${base}/share/0123456789abcdef/api/items?limit=2`, {
      method: "POST",
      headers: {
        authorization: "Bearer forged",
        cookie: "dsh_session=secret; app=value",
        "content-type": "application/json",
        "x-authenticated-user": "forged-user",
        "x-dsh-auth-user-id": "forged-user",
        "x-dsh-web-scope": "forged-scope",
        "x-forwarded-prefix": "/forged",
        "x-tenant-scope": "forged-tenant",
        origin: "https://chat.rwr.ink",
      },
      body: '{"ok":true}',
    });
    const response = await responsePromise;
    const reader = response.body!.getReader();
    const first = await reader.read();
    releaseResponse();
    const second = await reader.read();

    expect(response.status).toBe(200);
    expect(Buffer.from(first.value!).toString("utf8")).toBe("data: first\n\n");
    expect(Buffer.from(second.value!).toString("utf8")).toBe("data: second\n\n");
    expect(observed).toMatchObject({
      method: "POST",
      path: "/share/0123456789abcdef/api/items?limit=2",
      body: '{"ok":true}',
    });
    expect(observed.headers.authorization).toBe("Bearer worker-secret");
    expect(observed.headers["x-forwarded-prefix"]).toBe("/share/0123456789abcdef");
    expect(observed.headers.cookie).toBeUndefined();
    expect(observed.headers["x-authenticated-user"]).toBeUndefined();
    expect(observed.headers["x-dsh-auth-user-id"]).toBeUndefined();
    expect(observed.headers["x-dsh-web-scope"]).toBeUndefined();
    expect(observed.headers["x-tenant-scope"]).toBeUndefined();
    expect(observed.headers.origin).toBe("https://chat.rwr.ink");
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("strict-transport-security")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    await edge.close();
  });

  it("拒绝 share 的 TRACE 与 CONNECT", async () => {
    const preview = await listen((_req, res) => res.end("preview"));
    const worker = await listen((_req, res) => res.end("worker"));
    const { edge, base, port } = await listenEdge(worker.port, preview.port);

    const trace = await rawHttp(base, "TRACE", "/share/0123456789abcdef");
    expect(trace.status).toBe(405);
    expect(trace.body).toContain("METHOD_NOT_ALLOWED");

    const connectResponse = await rawSocket(port, "CONNECT /share/0123456789abcdef HTTP/1.1\r\nHost: edge.test\r\n\r\n");
    expect(connectResponse).toContain("HTTP/1.1 405 Method Not Allowed");

    await edge.close();
  });

  it("匿名代理公开 share WebSocket，并清除敏感头", async () => {
    let observedHeaders: IncomingMessage["headers"] | undefined;
    let observedPath: string | undefined;
    const preview = createServer();
    preview.on("upgrade", (req, socket) => {
      observedHeaders = req.headers;
      observedPath = req.url;
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") { socket.destroy(); return; }
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nStrict-Transport-Security: max-age=0\r\n\r\n`);
    });
    await bind(preview);
    cleanup.push(() => close(preview));
    const worker = await listen((_req, res) => res.end("worker"));
    const previewAddress = preview.address();
    if (!previewAddress || typeof previewAddress === "string") throw new Error("preview did not bind");
    const { edge, port } = await listenEdge(worker.port, previewAddress.port);

    const response = await rawSocket(port, [
      "GET /share/0123456789abcdef/socket?channel=events HTTP/1.1",
      "Host: edge.test",
      "Origin: https://outside.example",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${Buffer.from("share-websocket-test").toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "Cookie: dsh_session=secret",
      "Authorization: Bearer forged",
      "X-DSH-Web-Scope: forged",
      "X-Forwarded-Prefix: /forged",
      "",
      "",
    ].join("\r\n"));

    expect(response).toContain("HTTP/1.1 101 Switching Protocols");
    expect(response.toLowerCase()).not.toContain("strict-transport-security");
    expect(observedPath).toBe("/share/0123456789abcdef/socket?channel=events");
    expect(observedHeaders?.authorization).toBe("Bearer worker-secret");
    expect(observedHeaders?.["x-forwarded-prefix"]).toBe("/share/0123456789abcdef");
    expect(observedHeaders?.cookie).toBeUndefined();
    expect(observedHeaders?.["x-dsh-web-scope"]).toBeUndefined();
    expect(observedHeaders?.origin).toBe("https://outside.example");

    await edge.close();
  });
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>): Promise<Server & { port: number }> {
  const server = createServer((req, res) => { void handler(req, res); });
  await bind(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const result = Object.assign(server, { port: address.port });
  cleanup.push(() => close(result));
  return result;
}

async function listenEdge(workerPort: number, previewPort: number): Promise<{ edge: ReturnType<typeof createAuthEdgeServer>; base: string; port: number }> {
  const config = edgeConfig(workerPort, previewPort);
  const edge = createAuthEdgeServer({ config, service: new AuthService({ store: new MemoryAuthStore(), mail: new FakeMail() }) });
  await edge.listen();
  const address = edge.server.address();
  if (!address || typeof address === "string") throw new Error("edge did not bind");
  cleanup.push(() => edge.close());
  return { edge, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

function edgeConfig(workerPort: number, previewPort: number): AuthEdgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    workerBaseUrl: `http://127.0.0.1:${workerPort}`,
    previewBaseUrl: `http://127.0.0.1:${previewPort}`,
    publicOrigin: "http://127.0.0.1:0",
    workerToken: "worker-secret",
    databaseUrl: "postgres://unused",
    userModelEncryptionKey: "A".repeat(43),
    trustedOrigins: ["http://127.0.0.1:0"],
    sessionCookieSecure: false,
    userWorkspaceRoot: "D:/workspaces/users",
    adminWorkspaceRoot: "D:/workspaces/admin",
    requestBodyLimit: 128 * 1024,
    mail: { mode: "console", port: 465, secure: true },
  };
}

async function rawHttp(base: string, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, base), { method }, async (response) => {
      try { resolve({ status: response.statusCode ?? 0, body: await collect(response) }); } catch (error) { reject(error); }
    });
    request.once("error", reject);
    request.end();
  });
}

async function rawSocket(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function collect(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function bind(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
