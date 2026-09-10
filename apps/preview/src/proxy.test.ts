import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import type { PreviewManager } from "./manager.js";
import { filterRequestHeaders, forwardRequestBody, proxyHttp, rewriteHtml, rewriteResponseHeaders } from "./proxy.js";

describe("Preview proxy headers", () => {
  it("不向用户服务转发平台身份与内部头", () => {
    expect(filterRequestHeaders({
      authorization: "Bearer secret", cookie: "session=secret", "x-dsh-auth-user-id": "u",
      "proxy-authorization": "secret", accept: "text/event-stream", "accept-encoding": "gzip", "content-length": "10",
    }, "a".repeat(32))).toEqual({
      accept: "text/event-stream", host: "127.0.0.1", connection: "close", "x-forwarded-prefix": `/share/${"a".repeat(32)}`,
    });
  });

  it("过滤平台安全头并重写同源 Location 与 Cookie Path", () => {
    const id = "b".repeat(32);
    expect(rewriteResponseHeaders([
      ["Location", "/login"], ["Set-Cookie", "sid=1; HttpOnly; Path=/"],
      ["Strict-Transport-Security", "max-age=1"], ["X-Dsh-Identity", "secret"], ["Transfer-Encoding", "chunked"],
    ], id)).toEqual({
      location: `/share/${id}/login`,
      "set-cookie": `sid=1; HttpOnly; Path=/share/${id}/`,
    });
  });

  it("重写 HTML 根路径并用标准 base URL 适配相对资源", () => {
    const id = "c".repeat(32);
    const output = rewriteHtml('<html><head></head><body><script src="/app.js"></script><a href="/docs">x</a><form action="/api"></form></body></html>', id);
    expect(output).toContain(`src="/share/${id}/app.js"`);
    expect(output).toContain(`href="/share/${id}/docs"`);
    expect(output).toContain(`action="/share/${id}/api"`);
    expect(output).toContain(`<base href="/share/${id}/">`);
    for (const api of ["window.fetch", "XMLHttpRequest.prototype", "window.WebSocket", "window.EventSource"]) expect(output).not.toContain(api);
  });

  it("chunked 请求按实际字节累计并在超限时销毁上游", async () => {
    const sink = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValue(true), end: vi.fn(), destroy: vi.fn(),
    });
    async function* chunks() { yield Buffer.from("123"); yield Buffer.from("456"); }
    await expect(forwardRequestBody(chunks(), sink, 5)).rejects.toMatchObject({ code: "PREVIEW_INVALID_INPUT" });
    expect(sink.destroy).toHaveBeenCalledOnce();
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("上游写缓冲区满时等待 drain 再继续读取请求体", async () => {
    const sink = Object.assign(new EventEmitter(), {
      write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    let secondChunkRead = false;
    async function* chunks() {
      yield Buffer.from("first");
      secondChunkRead = true;
      yield Buffer.from("second");
    }
    const forwarding = forwardRequestBody(chunks(), sink, 32);
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(secondChunkRead).toBe(false);
    sink.emit("drain");
    await forwarding;
    expect(secondChunkRead).toBe(true);
    expect(sink.end).toHaveBeenCalledOnce();
  });

  it("HTTP 请求只经子进程字节桥抵达指定上游", async () => {
    const upstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"bridge":"ok"}');
    });
    const upstreamPort = await listen(upstream);
    const bridgeScript = "const net=require('node:net');const s=net.connect(Number(process.argv[1]),'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout)";
    const manager = {
      resolvePublic: async () => ({
        descriptor: { port: upstreamPort },
        bridge: () => spawn(process.execPath, ["-e", bridgeScript, String(upstreamPort)]),
      }),
    } as unknown as PreviewManager;
    const proxy = createServer((req, res) => {
      void proxyHttp(manager, "d".repeat(32), req.url || "/", req, res, 2_000, 1_024);
    });
    const proxyPort = await listen(proxy);
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/api`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bridge: "ok" });
    } finally {
      await Promise.all([close(proxy), close(upstream)]);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("test server has no TCP address"));
      resolvePromise(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
}
