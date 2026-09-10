import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { PassThrough, type Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { createWebSocketClientFrameObserver, createWebSocketServerFrameFilter, proxyUpgrade, requestUpstream } from "./proxy.js";

const SOCKET_CLOSE_TIMEOUT_MS = 1_000;

describe("HTTP upstream proxy", () => {
  it("ends an empty GET without piping the client request stream", async () => {
    const worker = createServer((_req, res) => { res.end("ok"); });
    await listen(worker);
    const request = fakeRequest("GET");
    let pipeCalled = false;
    request.pipe = (() => { pipeCalled = true; throw new Error("GET request was piped"); }) as IncomingMessage["pipe"];
    const response = await requestUpstream(`http://127.0.0.1:${port(worker)}`, request);
    expect(response.body.toString("utf8")).toBe("ok");
    expect(pipeCalled).toBe(false);
    await close(worker);
  });

  it("rejects and destroys the upstream request when the client aborts", async () => {
    const worker = createServer(() => undefined);
    await listen(worker);
    const request = fakeRequest("GET");
    const pending = requestUpstream(`http://127.0.0.1:${port(worker)}`, request);
    setTimeout(() => request.emit("aborted"), 20);
    await expect(pending).rejects.toThrow("client request aborted");
    await close(worker);
  });

  it("剥离浏览器伪造的 Web Scope，只转发 Auth Edge 生成值", async () => {
    let received: string | string[] | undefined;
    const worker = createServer((req, res) => { received = req.headers["x-dsh-web-scope"]; res.end("ok"); });
    await listen(worker);
    const request = fakeRequest("POST", "/api/session.prompt", { host: "edge.test", "x-dsh-web-scope": "forged" });
    await requestUpstream(`http://127.0.0.1:${port(worker)}`, request, Buffer.from("{}"), { "x-dsh-web-scope": "trusted" });
    expect(received).toBe("trusted");
    await close(worker);
  });

  it("不向可缓冲改写的上游请求压缩响应", async () => {
    let encoding: string | undefined;
    const worker = createServer((req, res) => {
      encoding = req.headers["accept-encoding"] as string | undefined;
      res.end("plain");
    });
    await listen(worker);
    const request = fakeRequest("GET", "/", { host: "edge.test", "accept-encoding": "gzip, br" });
    const response = await requestUpstream(`http://127.0.0.1:${port(worker)}`, request);
    expect(encoding).toBeUndefined();
    expect(response.body.toString("utf8")).toBe("plain");
    await close(worker);
  });
});

describe("WebSocket upstream proxy", () => {
  it("does not contact upstream when the downstream is already destroyed", async () => {
    const worker = createServer();
    let connections = 0;
    worker.on("connection", (socket) => { connections += 1; socket.destroy(); });
    await listen(worker);
    const client = new PassThrough();
    client.destroy();
    try {
      proxyUpgrade(`http://127.0.0.1:${port(worker)}`, fakeUpgradeRequest(), client, Buffer.alloc(0));
      await delay(100);
      expect(connections).toBe(0);
    } finally {
      await close(worker);
    }
  });

  it("destroys a late upstream upgrade after the downstream closes", async () => {
    const worker = createServer();
    let upstreamSocket: Duplex | undefined;
    let allowUpgrade!: () => void;
    const upgradeAllowed = new Promise<void>((resolve) => { allowUpgrade = resolve; });
    const upgradeReceived = new Promise<void>((resolve) => {
      worker.once("upgrade", (request, socket) => {
        upstreamSocket = socket;
        socket.on("error", () => undefined);
        socket.resume();
        socket.once("end", () => socket.destroy());
        const key = request.headers["sec-websocket-key"] as string;
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        void upgradeAllowed.then(() => {
          if (!socket.destroyed) socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        });
        resolve();
      });
    });
    await listen(worker);
    const client = new PassThrough();
    try {
      proxyUpgrade(`http://127.0.0.1:${port(worker)}`, fakeUpgradeRequest(), client, Buffer.alloc(0));
      await upgradeReceived;
      const upstreamClosed = socketClosed(upstreamSocket!);
      const clientClosed = socketClosed(client);
      client.destroy();
      await clientClosed;
      allowUpgrade();
      expect(await settlesWithin(upstreamClosed, SOCKET_CLOSE_TIMEOUT_MS)).toBe(true);
    } finally {
      allowUpgrade();
      client.destroy();
      upstreamSocket?.destroy();
      await close(worker);
    }
  });

  it("destroys an established upstream socket after the downstream closes", async () => {
    const worker = createServer();
    let upstreamSocket: Duplex | undefined;
    worker.once("upgrade", (request, socket) => {
      upstreamSocket = socket;
      socket.on("error", () => undefined);
      const key = request.headers["sec-websocket-key"] as string;
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.resume();
      socket.once("end", () => socket.destroy());
    });
    await listen(worker);
    const client = new PassThrough();
    try {
      const handshake = waitForHandshake(client);
      proxyUpgrade(`http://127.0.0.1:${port(worker)}`, fakeUpgradeRequest(), client, Buffer.alloc(0));
      await handshake;
      const upstreamClosed = socketClosed(upstreamSocket!);
      const clientClosed = socketClosed(client);
      client.destroy();
      await clientClosed;
      expect(await settlesWithin(upstreamClosed, SOCKET_CLOSE_TIMEOUT_MS)).toBe(true);
    } finally {
      client.destroy();
      upstreamSocket?.destroy();
      await close(worker);
    }
  });
});

describe("WebSocket server frame filter", () => {
  it("drops complete text messages without touching allowed frames", async () => {
    const filter = createWebSocketServerFrameFilter((text) => text.includes("allow") ? text : null);
    const output: Buffer[] = [];
    await collect(filter, output, Buffer.concat([textFrame("allow"), textFrame("drop")]));
    expect(Buffer.concat(output)).toEqual(textFrame("allow"));
  });

  it("preserves fragmented allowed messages and rejects compressed frames", async () => {
    const filter = createWebSocketServerFrameFilter((text) => text);
    const output: Buffer[] = [];
    const fragmented = Buffer.concat([Buffer.from([0x01, 0x02]), Buffer.from("al"), Buffer.from([0x80, 0x03]), Buffer.from("low")]);
    await collect(filter, output, fragmented);
    expect(Buffer.concat(output)).toEqual(fragmented);

    const invalid = createWebSocketServerFrameFilter(() => "ok");
    await expect(collect(invalid, [], Buffer.from([0xc1, 0x00]))).rejects.toThrow("unsupported WebSocket extensions");
  });

  it("rejects masked server frames and unknown control opcodes", async () => {
    await expect(collect(createWebSocketServerFrameFilter(() => "ok"), [], Buffer.from([0x81, 0x80, 0, 0, 0, 0]))).rejects.toThrow("masked WebSocket server frame");
    await expect(collect(createWebSocketServerFrameFilter(() => "ok"), [], Buffer.from([0x8b, 0x00]))).rejects.toThrow("unsupported WebSocket control opcode");
  });
});

describe("WebSocket client frame observer", () => {
  it("解码掩码文本供观察器读取，同时原样转发原始帧", async () => {
    const observed: string[] = [];
    const observer = createWebSocketClientFrameObserver((text) => observed.push(text));
    const input = maskedTextFrame(JSON.stringify({ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } }), Buffer.from([1, 2, 3, 4]));
    const output: Buffer[] = [];
    await collect(observer, output, input);
    expect(observed).toEqual([JSON.stringify({ type: "open", streamId: "events", endpoint: "$events", payload: { args: {} } })]);
    expect(Buffer.concat(output)).toEqual(input);
  });
});

function textFrame(value: string): Buffer {
  const payload = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function maskedTextFrame(value: string, mask: Buffer): Buffer {
  const payload = Buffer.from(value, "utf8");
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index++) encoded[index] = encoded[index]! ^ mask[index % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, encoded]);
}

function collect(stream: NodeJS.ReadableStream & NodeJS.WritableStream, output: Buffer[], input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => output.push(Buffer.from(chunk)));
    stream.once("end", resolve);
    stream.once("error", reject);
    stream.end(input);
  });
}

function fakeRequest(method: string, url = "/asset", headers: Record<string, string> = { host: "edge.test" }): IncomingMessage {
  const request = new PassThrough() as unknown as IncomingMessage & EventEmitter;
  const socket = new EventEmitter();
  Object.defineProperties(request, {
    method: { value: method },
    url: { value: url },
    headers: { value: headers },
    socket: { value: socket },
    complete: { value: true, writable: true },
  });
  return request;
}

function fakeUpgradeRequest(): IncomingMessage {
  return fakeRequest("GET", "/api/events.mux", {
    host: "edge.test",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": Buffer.from("proxy-upgrade-test").toString("base64"),
    "sec-websocket-version": "13",
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

function waitForHandshake(stream: Duplex): Promise<void> {
  return new Promise((resolve) => {
    let response = "";
    stream.on("data", (chunk: Buffer) => {
      response += chunk.toString("ascii");
      if (response.includes("\r\n\r\n")) resolve();
    });
  });
}

async function listen(server: Server): Promise<void> { await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); }
function port(server: Server): number { const address = server.address(); if (!address || typeof address === "string") throw new Error("worker did not bind"); return address.port; }
async function close(server: Server): Promise<void> { await new Promise<void>((resolve) => server.close(() => resolve())); }
