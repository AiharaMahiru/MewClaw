/** 云端桌面 WebServer Provider：使用公开服务契约组合，不覆写官方实例。 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import WebServer, { type Config as WebConfig, type WebRoute, type WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver';
import DesktopWebServer from 'dsh-plugin-desktop/webserver';
import z from '@deepseek-ai/schemastery';
import { CloudProxy, cloudOrigin } from './proxy.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DESKTOP_CLIENT_PATH, desktopCloudHtml } from './boot.js';

export interface Config extends WebConfig { cloudOrigin: string; cloudTimeoutMs: number; cloudMaxIndexBytes?: number }

/** 桌面私有控制面始终留在本机，不发送到云端。 */
export function isLocalDesktopPath(raw: string): boolean {
  const path = new URL(raw, 'http://127.0.0.1').pathname;
  return path.startsWith('/api/desktop/') || path.startsWith('/api/mewclaw-desktop/') || path.startsWith('/_dsh/desktop/');
}

export default class MewClawDesktopWebServer extends DesktopWebServer {
  static override Config = z.intersect([WebServer.Config, z.object({
    cloudOrigin: z.string().default('https://chat.rwr.ink'),
    cloudTimeoutMs: z.number().step(1).min(1000).max(600000).default(120000),
    cloudMaxIndexBytes: z.number().step(1).min(65536).max(8388608).default(2097152),
  })]);
  private readonly cloud: CloudProxy;
  private desktopParameters = '';

  constructor(ctx: Context, config: Config) {
    cloudOrigin(config.cloudOrigin);
    super(ctx, config);
    const require = createRequire(import.meta.url);
    const script = readFileSync(require.resolve('dsh-plugin-desktop/client'));
    const manifest = JSON.parse(readFileSync(require.resolve('dsh-plugin-desktop/package.json'), 'utf8'));
    const client = { revision: createHash('sha256').update(script).digest('hex').slice(0, 16), inject: manifest.dsh.client.inject as string[] };
    this.cloud = new CloudProxy({ origin: config.cloudOrigin, timeoutMs: config.cloudTimeoutMs,
      maxIndexBytes: config.cloudMaxIndexBytes ?? 2097152,
      transformIndex: html => desktopCloudHtml(html, client, this.desktopParameters),
    });
    ctx.effect(() => () => this.cloud.dispose());
    ctx.effect(() => this.register({ kind: 'exact', path: DESKTOP_CLIENT_PATH, handler: (req, res) => {
      const rejection = this.ctx.get('connection')?.requestRejection(req);
      if (!this.ctx.get('connection') || rejection !== undefined) { res.writeHead(rejection ?? 503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(script);
    } }));
  }

  private wrap(handler: WebRoute['handler']): WebRoute['handler'] {
    return (req, res) => {
      if (isLocalDesktopPath(req.url ?? '/')) return handler(req, res);
      const connection = this.ctx.get('connection');
      if (!connection) { res.writeHead(503); res.end('DESKTOP_STARTING'); return; }
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/' && !connection.authorizeIndex(req, res)) return;
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end('DESKTOP_UNAUTHORIZED'); return; }
      const parameters = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      if (parameters.has('dsh-desktop-mode')) {
        const retained = new URLSearchParams();
        for (const [key, value] of parameters) if (key.startsWith('dsh-desktop-') && value.length < 128) retained.set(key, value);
        this.desktopParameters = retained.toString();
      }
      this.cloud.http(req, res);
    };
  }

  override register(route: WebRoute): () => void {
    return super.register({ ...route, handler: this.wrap(route.handler) });
  }

  override registerFallback(handler: WebRoute['handler']): () => void {
    return super.registerFallback(this.wrap(handler));
  }

  override registerUpgrade(route: WebUpgradeRoute): () => void {
    return super.registerUpgrade({ ...route, handler: (req, socket, head) => {
      if (isLocalDesktopPath(req.url ?? '/')) return route.handler(req, socket, head);
      const connection = this.ctx.get('connection');
      if (!connection || connection.requestRejection(req) !== undefined) { socket.destroy(); return; }
      this.cloud.upgrade(req, socket, head);
    } });
  }
}
