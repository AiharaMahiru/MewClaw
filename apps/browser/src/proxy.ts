import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import type { UrlPolicy } from "./url-policy.js";

/**
 * Chromium 的所有 HTTP(S) 出站都经此 loopback 代理。代理使用 URL 策略同一次 DNS
 * 解析得到的 IP 建立 TCP，避免校验后由 Chromium 二次解析产生 DNS 重绑定窗口。
 */
export class BrowserEgressProxy {
  readonly #server: Server;

  constructor(private readonly policy: UrlPolicy) {
    this.#server = createServer((request, response) => { void this.#http(request, response); });
    this.#server.on("connect", (request, socket, head) => { void this.#connect(request.url || "", socket, head); });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("浏览器代理监听失败");
    return address.port;
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #http(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const resolved = await this.policy.resolveAllowed(incoming.url || "", true);
      const address = resolved.addresses[0]?.address;
      if (!address) throw new Error("目标地址不可用");
      const headers: OutgoingHttpHeaders = { ...incoming.headers, host: resolved.url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest({
        host: address,
        port: portOf(resolved.url),
        method: incoming.method,
        path: `${resolved.url.pathname}${resolved.url.search}`,
        headers,
        family: resolved.addresses[0]?.family,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", () => failHttp(response));
      incoming.pipe(upstream);
    } catch {
      failHttp(response);
    }
  }

  async #connect(authority: string, client: Duplex, head: Buffer): Promise<void> {
    try {
      const target = authorityUrl(authority);
      const resolved = await this.policy.resolveAllowed(target.href, true);
      const address = resolved.addresses[0]?.address;
      if (!address) throw new Error("目标地址不可用");
      const upstream = connect({ host: address, port: portOf(target), family: resolved.addresses[0]?.family });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("error", () => failConnect(client));
      client.once("error", () => upstream.destroy());
    } catch {
      failConnect(client);
    }
  }
}

function authorityUrl(authority: string): URL {
  const url = new URL(`https://${authority}`);
  if (!url.hostname || url.username || url.password) throw new Error("代理目标非法");
  return url;
}

function portOf(url: URL): number {
  const value = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("代理端口非法");
  return value;
}

function failHttp(response: ServerResponse): void {
  if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
  response.end("blocked");
}

function failConnect(socket: Duplex): void {
  if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
}
