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
import { LocationPreference } from './location.js';
import { locationRoute } from './location-route.js';
import { installLocalBrand } from './local-brand.js';
import { sessionLocationHtml } from './session-boot.js';
import { LocalHarnessWorkspaces } from './local-workspaces.js';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { CloudAccountModel, CLOUD_MODEL_PROVIDER } from './cloud-model.js';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

export interface Config extends WebConfig, Omit<ControllerOptions, 'fs' | 'pick' | 'shell' | 'confirm' | 'maxBytes' | 'maxEntries'> { cloudOrigin: string; cloudTimeoutMs: number; cloudSessionRetentionSeconds?: number; workspaceMaxBytes?: number; workspaceMaxEntries?: number; cloudMaxIndexBytes?: number }

/** 桌面私有控制面始终留在本机，不发送到云端。 */
export function isLocalDesktopPath(raw: string): boolean {
  const path = new URL(raw, 'http://127.0.0.1').pathname;
  return path.startsWith('/api/desktop/') || path.startsWith('/api/mewclaw-desktop/') || path.startsWith('/_dsh/desktop/');
}

/** 本地 Harness 仍把账号级配置/模型元数据交给云端，密钥只在云端解密使用。 */
export function isCloudSynchronizedPath(raw: string): boolean {
  const path = new URL(raw, 'http://127.0.0.1').pathname;
  return path === '/api/dsh-web-ui-settings/describe'
    || path === '/api/dsh-web-ui-settings/mutate'
    || path === '/auth/models'
    || path.startsWith('/auth/models/');
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
  private localWorkspaces?: LocalHarnessWorkspaces;
  private cloudModel?: CloudAccountModel;
  private accountCookie = '';
  private readonly location = new LocationPreference(resolveDshHome());
  private localBrandRevision = '';

  constructor(ctx: Context, config: Config) {
    cloudOrigin(config.cloudOrigin);
    super(ctx, config);
    const require = createRequire(import.meta.url);
    const script = readFileSync(require.resolve('dsh-plugin-desktop/client'));
    const manifest = JSON.parse(readFileSync(require.resolve('dsh-plugin-desktop/package.json'), 'utf8'));
    const workspaceScript = Buffer.from(readFileSync(new URL('../lib/workspace-client.js', import.meta.url), 'utf8').replace('\nexport {};', ''));
    const locationScript = Buffer.from(readFileSync(new URL('../lib/location-client.js', import.meta.url), 'utf8').replace('\nexport {};', ''));
    const client = {
      workspaceRevision: createHash('sha256').update(workspaceScript).digest('hex').slice(0, 16),
      locationRevision: createHash('sha256').update(locationScript).digest('hex').slice(0, 16),
      revision: createHash('sha256').update(script).digest('hex').slice(0, 16),
      inject: manifest.dsh.client.inject as string[],
    };
    this.localBrandRevision = installLocalBrand(ctx);
    this.cloud = new CloudProxy({ origin: config.cloudOrigin, timeoutMs: config.cloudTimeoutMs,
      sessionRetentionSeconds: config.cloudSessionRetentionSeconds ?? 2592000,
      maxIndexBytes: config.cloudMaxIndexBytes ?? 2097152,
      transformIndex: html => this.transformCloudIndex(html, client),
    });
    ctx.effect(() => () => this.cloud.dispose());
    this.installWorkspace(ctx, config, workspaceScript);
    this.installLocation(ctx, config, locationScript, client.locationRevision);
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
    const bridge = localWorkspaceRoute({ origin: config.cloudOrigin, controller, reject });
    ctx.effect(() => this.register({ kind: 'exact', path: '/api/mewclaw-desktop/workspace', handler: (req, res) => {
      if (this.location.location === 'local') { res.writeHead(409); res.end('CLOUD_WORKSPACE_DISABLED_IN_LOCAL_MODE'); return; }
      return bridge(req, res);
    } }));
    ctx.effect(() => this.register({ kind: 'exact', path: '/_dsh/desktop/workspace-client.js', handler: (req, res) => {
      const rejection = reject(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(script);
    } }));
  }

  private installLocation(ctx: Context, config: Config, script: Buffer, revision: string): void {
    const reject = (req: Parameters<WebRoute['handler']>[0]) => ctx.get('connection')?.requestRejection(req) ?? (ctx.get('connection') ? undefined : 503);
    ctx.effect(() => this.register({ kind: 'exact', path: '/api/mewclaw-desktop/location', handler: locationRoute({
      preference: this.location, reject,
    }) }));
    ctx.effect(() => this.register({ kind: 'exact', path: '/_dsh/desktop/location-client.js', handler: (req, res) => {
      const rejection = reject(req);
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(script);
    } }));
    ctx.effect(() => this.tapIndex(html => this.transformLocalIndex(html, revision)));
    ctx.inject(['tools'], local => local.effect(() => local.tools.guard(exec => {
      if (exec.name === 'desktop_workspace') return this.location.location === 'local' ? undefined : 'LOCAL_TOOL_NOT_AUTHORIZED';
      return this.location.location === 'local' ? 'LOCAL_TOOL_NOT_AUTHORIZED' : undefined;
    })));
    ctx.inject(['llm', 'agentDefaultModel'], async local => {
      const adapter = new CloudAccountModel({ origin: cloudOrigin(config.cloudOrigin).origin,
        cookie: () => this.accountCookie, enabled: () => this.location.location === 'local' });
      this.cloudModel = adapter;
      local.effect(() => local.llm.registerAdapter([CLOUD_MODEL_PROVIDER], adapter));
      let cloudSelection = this.location.location === 'local' ? local.agentDefaultModel.currentSelection() : undefined;
      let transition = Promise.resolve();
      const apply = async (next: 'cloud' | 'local') => {
        if (next === 'local') {
          if (!cloudSelection) cloudSelection = local.agentDefaultModel.currentSelection();
          await local.agentDefaultModel.saveSelection({ provider: CLOUD_MODEL_PROVIDER, model: 'cloud-default' });
        } else if (cloudSelection) {
          const restore = cloudSelection;
          cloudSelection = undefined;
          await local.agentDefaultModel.saveSelection(restore);
        }
      };
      const schedule = (next: 'cloud' | 'local') => {
        transition = transition.then(() => apply(next)).catch(error => {
          // 模型选择写入是模式切换的附加同步；不能阻塞本机位置控制面。
          this.ctx.logger.warn(`云端账号模型选择同步失败：${error instanceof Error ? error.message : String(error)}`);
        });
      };
      const unsubscribe = this.location.subscribe(next => { schedule(next); });
      local.effect(() => unsubscribe);
      schedule(this.location.location);
    });
    ctx.inject(['tools', 'fs', 'sessions', 'workspaceRegistry'], local => {
      const workspaces = new LocalHarnessWorkspaces(local, { maxBytes: config.workspaceMaxBytes ?? 262144, maxEntries: config.workspaceMaxEntries ?? 500 });
      this.localWorkspaces = workspaces;
      workspaces.install(local);
      const unsubscribeLocation = this.location.subscribe(next => {
        if (next !== 'local') workspaces.dispose();
      });
      local.effect(() => unsubscribeLocation);
      local.effect(() => this.register({ kind: 'exact', path: '/api/mewclaw-desktop/local-directory', handler: async (req, res) => {
        const rejection = reject(req);
        if (rejection !== undefined || req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(rejection ?? 403); res.end(); return; }
        if (this.location.location !== 'local') { res.writeHead(409); res.end('LOCAL_MODE_REQUIRED'); return; }
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        try {
          const value = await workspaces.pick();
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value));
        } catch { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'LOCAL_DIRECTORY_UNAVAILABLE' })); }
      } }));
    });
  }

  private transformCloudIndex(html: string, client: { revision: string; inject: string[]; locationRevision: string; workspaceRevision: string }): string {
    const location = this.location.location;
    const transformed = desktopCloudHtml(html, client, this.desktopParameters);
    const options: Parameters<typeof sessionLocationHtml>[1] = { location, locationRevision: client.locationRevision };
    if (location === 'cloud') options.workspaceRevision = client.workspaceRevision;
    if (location === 'local') options.brandRevision = this.localBrandRevision;
    return sessionLocationHtml(transformed, options);
  }

  private transformLocalIndex(html: string, revision: string): string {
    const options: Parameters<typeof sessionLocationHtml>[1] = { location: this.location.location, locationRevision: revision };
    if (this.location.location === 'local') options.brandRevision = this.localBrandRevision;
    return sessionLocationHtml(html, options);
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
      this.accountCookie = (req.headers.cookie ?? '').split(';').map(value => value.trim())
        .filter(value => /^(?:__Host-dsh_session|dsh_session|dsh_csrf)=/.test(value)).join('; ');
      if (path.startsWith('/auth/models') && req.method !== 'GET') this.cloudModel?.invalidateCatalog();
      if (path === '/auth/logout') { this.workspace?.revokeAll(); this.localWorkspaces?.dispose(); this.accountCookie = ''; }
      if (this.location.location === 'local' && !path.startsWith('/auth/') && !isCloudSynchronizedPath(path)) return handler(req, res);
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
      if (this.location.location === 'local') return route.handler(req, socket, head);
      this.cloud.upgrade(req, socket, head);
    } });
  }
}
