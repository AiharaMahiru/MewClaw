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
import { WorkspaceController } from './workspace-controller.js';
import { localWorkspaceRoute } from './workspace-route.js';
import type {} from '@deepseek-ai/dsh-shell';
import type { ControllerOptions } from './workspace-controller.js';

export interface Config extends WebConfig, Omit<ControllerOptions, 'fs' | 'pick' | 'shell' | 'confirm' | 'maxBytes' | 'maxEntries'> { cloudOrigin: string; cloudTimeoutMs: number; cloudSessionRetentionSeconds?: number; workspaceMaxBytes?: number; workspaceMaxEntries?: number; cloudMaxIndexBytes?: number }

/** 桌面私有控制面始终留在本机，不发送到云端。 */
export function isLocalDesktopPath(raw: string): boolean {
  const path = new URL(raw, 'http://127.0.0.1').pathname;
  return path.startsWith('/api/desktop/') || path.startsWith('/api/mewclaw-desktop/') || path.startsWith('/_dsh/desktop/');
}

export default class MewClawDesktopWebServer extends DesktopWebServer {
  static override Config = z.intersect([WebServer.Config, z.object({
    workspaceMaxBytes: z.number().step(1).min(1024).max(1048576).default(262144),
    workspaceMaxEntries: z.number().step(1).min(1).max(2000).default(500),
    maxBindings: z.number().step(1).min(1).max(100).default(10),
    pollIntervalMs: z.number().step(1).min(250).max(5000).default(1000),
    shellTimeoutMs: z.number().step(1).min(1000).max(120000).default(30000),
    shellMaxOutputBytes: z.number().step(1).min(1024).max(262144).default(65536),
    syncIntervalMs: z.number().step(1).min(1000).max(60000).default(5000),
    syncMaxBytes: z.number().step(1).min(1024).max(4194304).default(1048576),
    syncMaxEntries: z.number().step(1).min(1).max(10000).default(2000),
    syncMaxTotalBytes: z.number().step(1).min(1024).max(268435456).default(33554432),
    cloudOrigin: z.string().default('https://chat.rwr.ink'),
    cloudTimeoutMs: z.number().step(1).min(1000).max(600000).default(120000),
    cloudSessionRetentionSeconds: z.number().step(1).min(0).max(2592000).default(2592000),
    cloudMaxIndexBytes: z.number().step(1).min(65536).max(8388608).default(2097152),
  })]);
  private readonly cloud: CloudProxy;
  private desktopParameters = '';
  private workspace?: WorkspaceController;

  constructor(ctx: Context, config: Config) {
    cloudOrigin(config.cloudOrigin);
    super(ctx, config);
    const require = createRequire(import.meta.url);
    const script = readFileSync(require.resolve('dsh-plugin-desktop/client'));
    const manifest = JSON.parse(readFileSync(require.resolve('dsh-plugin-desktop/package.json'), 'utf8'));
    const workspaceScript = Buffer.from(readFileSync(new URL('../lib/workspace-client.js', import.meta.url), 'utf8').replace('\nexport {};', ''));
    const client = { workspaceRevision: createHash('sha256').update(workspaceScript).digest('hex').slice(0, 16), revision: createHash('sha256').update(script).digest('hex').slice(0, 16), inject: manifest.dsh.client.inject as string[] };
    this.cloud = new CloudProxy({ origin: config.cloudOrigin, timeoutMs: config.cloudTimeoutMs,
      sessionRetentionSeconds: config.cloudSessionRetentionSeconds ?? 2592000,
      maxIndexBytes: config.cloudMaxIndexBytes ?? 2097152,
      transformIndex: html => desktopCloudHtml(html, client, this.desktopParameters),
    });
    ctx.effect(() => () => this.cloud.dispose());
    this.installWorkspace(ctx, config, workspaceScript);
    ctx.effect(() => this.register({ kind: 'exact', path: DESKTOP_CLIENT_PATH, handler: (req, res) => {
      const rejection = this.ctx.get('connection')?.requestRejection(req);
      if (!this.ctx.get('connection') || rejection !== undefined) { res.writeHead(rejection ?? 503); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(script);
    } }));
  }

  private installWorkspace(ctx: Context, config: Config, script: Buffer): void {
    const reject = (req: Parameters<WebRoute['handler']>[0]) => {
      const connection = ctx.get('connection');
      return connection ? connection.requestRejection(req) : 503;
    };
    this.workspace = new WorkspaceController({
      ...config,
      shell: () => { const shell = ctx.get('shell'); if (!shell) throw new Error('LOCAL_SHELL_UNAVAILABLE'); return shell; },
      confirm: async kind => {
        // Electron 主进程的官方原生对话框，不以网页确认框代替宿主授权。
        const { dialog } = await import('electron');
        const result = await dialog.showMessageBox({ type: 'warning', title: 'MewClaw 本机授权',
          message: kind === 'shell' ? '允许云端模型在这台电脑执行 Shell 命令？' : '允许当前目录与当前会话的云端目录双向同步？',
          detail: kind === 'shell' ? '命令以你的系统账号权限运行，工作目录不是沙箱，可能访问目录之外的文件和网络。命令输出会发送到云端。退出登录或撤销会终止当前命令。'
            : '目录中的文件（包括二进制文件）将上传到云端，也会下载云端修改。两边同时修改会保留冲突；传播删除和替换时保留恢复副本。默认排除 .env、.git、node_modules。',
          buttons: ['取消', '允许'], defaultId: 0, cancelId: 0, noLink: true });
        return result.response === 1;
      },
      fs: () => { const fs = ctx.get('fs'); if (!fs) throw new Error('WORKSPACE_STARTING'); return fs; },
      pick: () => { const runtime = ctx.get('desktopRuntime') as { pickDirectory(): Promise<string | null> } | undefined;
        if (!runtime) throw new Error('WORKSPACE_STARTING'); return runtime.pickDirectory(); },
      maxBytes: config.workspaceMaxBytes ?? 262144, maxEntries: config.workspaceMaxEntries ?? 500,
    });
    const controller = this.workspace;
    ctx.effect(() => () => controller.dispose());
    ctx.effect(() => this.register({ kind: 'exact', path: '/api/mewclaw-desktop/workspace',
      handler: localWorkspaceRoute({ origin: config.cloudOrigin, controller, reject }) }));
    ctx.effect(() => this.register({ kind: 'exact', path: '/_dsh/desktop/workspace-client.js', handler: (req, res) => {
      const rejection = reject(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
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
      if (path === '/auth/logout') this.workspace?.revokeAll();
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
