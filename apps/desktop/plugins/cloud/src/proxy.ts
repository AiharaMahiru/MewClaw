/** 桌面到固定云端的流式传输；不持久化账号 Cookie，不允许请求选择上游。 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
export interface CloudProxyConfig { origin: string; timeoutMs: number; maxIndexBytes?: number; transformIndex?: (html: string) => string }

/** 只接受无凭证 HTTPS origin；本机测试可使用回环 HTTP。 */
export function cloudOrigin(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('INVALID_CLOUD_ORIGIN');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('INVALID_CLOUD_ORIGIN');
  return url;
}

/** 连接归当前 Provider 所有；退出时终止传输，不继续运行重连任务。 */
export class CloudProxy {
  readonly origin: URL;
  readonly #active = new Set<{ destroy(): void }>();
  #disposed = false;
  constructor(readonly config: CloudProxyConfig) { this.origin = cloudOrigin(config.origin); }

  private target(req: IncomingMessage): URL {
    const path = req.url ?? '/';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new Error('INVALID_PROXY_PATH');
    const target = new URL(path, this.origin);
    if (target.origin !== this.origin.origin) throw new Error('INVALID_PROXY_PATH');
    // 本地启动令牌与窗口几何只属于桌面，永不转发云端。
    if (target.pathname === '/') target.searchParams.delete('token');
    for (const key of [...target.searchParams.keys()]) if (key.startsWith('dsh-desktop-')) target.searchParams.delete(key);
    return target;
  }

  private headers(req: IncomingMessage, upgrade: boolean): Record<string, string | string[]> {
    const headers: Record<string, string | string[]> = {};
    const connectionHeaders = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(v => v.trim()));
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_HEADERS.has(key) || connectionHeaders.has(key)
        || key === 'host' || key === 'authorization' || key.startsWith('x-forwarded-')
        || key.startsWith('x-dsh-') || key === 'forwarded') continue;
      headers[key] = value;
    }
    headers.host = this.origin.host;
    if (this.config.transformIndex && new URL(req.url ?? '/', this.origin).pathname === '/') headers['accept-encoding'] = 'identity';
    if (req.headers.origin) headers.origin = this.origin.origin;
    if (req.headers.referer) headers.referer = `${this.origin.origin}/`;
    if (headers.cookie) {
      // 官方本地 Connection 的 Cookie 不作为云端身份凭据。
      headers.cookie = String(headers.cookie).split(';').map(v => v.trim())
        .filter(v => !v.startsWith('dsh-auth-')).join('; ');
    }
    if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return headers;
  }

  /** 转发普通 HTTP 与 SSE；浏览器关闭后及时释放上游。 */
  http(req: IncomingMessage, res: ServerResponse): void {
    if (this.#disposed) { res.writeHead(503); res.end(); return; }
    let target: URL;
    try { target = this.target(req); } catch { res.writeHead(400); res.end('INVALID_PROXY_PATH'); return; }
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = request(target, { method: req.method ?? 'GET', headers: this.headers(req, false) });
    this.#active.add(upstream);
    const abort = (): void => { upstream.destroy(); };
    req.once('aborted', abort);
    res.once('close', abort);
    upstream.once('close', () => {
      this.#active.delete(upstream); req.off('aborted', abort); res.off('close', abort);
    });
    upstream.setTimeout(this.config.timeoutMs, () => upstream.destroy(new Error('CLOUD_TIMEOUT')));
    upstream.once('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end('云端连接暂不可用，请重试。'); }
      else res.destroy();
    });
    upstream.once('response', response => {
      const headers = { ...response.headers };
      for (const key of HOP_HEADERS) delete headers[key];
      if (headers.location) {
        const location = new URL(headers.location, this.origin);
        if (location.origin === this.origin.origin) headers.location = `${location.pathname}${location.search}${location.hash}`;
      }
      if (this.config.transformIndex && target.pathname === '/' && req.method === 'GET'
        && String(headers['content-type']).includes('text/html') && response.statusCode === 200) {
        const chunks: Buffer[] = []; let size = 0;
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') {
          response.destroy(); res.writeHead(502); res.end('UNSUPPORTED_CLOUD_ENCODING'); return;
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > (this.config.maxIndexBytes ?? 2097152)) { response.destroy(); res.destroy(); }
          else chunks.push(chunk);
        });
        response.once('error', () => res.destroy());
        response.once('end', () => {
          try {
            const html = this.config.transformIndex!(Buffer.concat(chunks).toString('utf8'));
            delete headers['content-length']; delete headers.etag;
            res.writeHead(200, { ...headers, 'cache-control': 'no-store' }); res.end(html);
          } catch { res.writeHead(502); res.end('CLOUD_DESKTOP_BOOT_INCOMPATIBLE'); }
        });
        return;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.once('error', () => res.destroy());
      response.pipe(res);
    });
    req.pipe(upstream);
  }

  /** 转发官方 WebSocket，不重放客户端消息；重连仍由官方客户端负责。 */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#disposed) { socket.destroy(); return; }
    let target: URL;
    try { target = this.target(req); } catch { socket.destroy(); return; }
    const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstream = request(target, { headers: this.headers(req, true) });
    this.#active.add(upstream); this.#active.add(socket);
    const close = (): void => { upstream.destroy(); this.#active.delete(upstream); this.#active.delete(socket); };
    socket.once('close', close); socket.once('error', () => socket.destroy());
    upstream.once('error', () => socket.destroy());
    upstream.setTimeout(this.config.timeoutMs, () => upstream.destroy());
    upstream.once('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
    upstream.once('upgrade', (response, remote, remoteHead) => {
      this.#active.add(remote);
      remote.once('error', () => remote.destroy());
      remote.once('close', () => { this.#active.delete(remote); socket.destroy(); });
      socket.once('close', () => remote.destroy());
      const headers = Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : Array.isArray(value) ? value.map(v => `${key}: ${v}`) : [`${key}: ${value}`]);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
    });
    upstream.end();
  }

  dispose(): void {
    this.#disposed = true;
    for (const resource of this.#active) resource.destroy();
    this.#active.clear();
  }
}
