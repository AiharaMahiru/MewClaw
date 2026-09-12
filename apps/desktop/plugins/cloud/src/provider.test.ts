import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Provider, { isCloudSynchronizedPath } from './index.js';

describe('真实 Cordis Provider 注册', () => {
  it('云端与本地切换只刷新页面，当前 WebServer 继续服务新的 BootGraph', async () => {
    const html = '<html><head><script>globalThis["__DSH_BOOT__"] = ' + JSON.stringify({
      rev: 'cloud', entries: [
        { id: 'dsh-lark-web-auth', url: '/auth.js', rev: '1' },
        ...['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-theme',
          '@deepseek-ai/dsh-client-ui-sidebar'].map(id => ({ id, url: `/${id}.js`, rev: '1' })),
      ],
      batches: [{ phase: 'application', url: '/boot.js', rev: '1', entries: [
        'dsh-lark-web-auth', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-theme', '@deepseek-ai/dsh-client-ui-sidebar',
      ] }],
    }) + ';</script></head><body></body></html>';
    const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
    const home = await mkdtemp(join(tmpdir(), 'mewclaw-provider-switch-'));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const ctx = new Context();
    ctx.provide('connection', { requestRejection: () => undefined, authorizeIndex: () => true });
    try {
      await ctx.plugin(Provider, { host: '127.0.0.1', port: 0, cloudOrigin: `http://127.0.0.1:${address.port}`, cloudTimeoutMs: 1000 });
      const server = ctx.webServer;
      const fallback = server.registerFallback((_req, res) => res.end(server.renderIndex(html)));
      const base = `http://127.0.0.1:${server.port}`;
      const cloud = await (await fetch(base)).text();
      expect(cloud).toContain('__MEWCLAW_SESSION_LOCATION__="cloud"');
      const switchedLocal = await fetch(`${base}/api/mewclaw-desktop/location`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ location: 'local' }),
      });
      expect(switchedLocal.status).toBe(200);
      expect((await switchedLocal.json()).reload).toBe(true);
      const local = await (await fetch(base)).text();
      expect(local).toContain('__MEWCLAW_SESSION_LOCATION__="local"');
      const switchedCloud = await fetch(`${base}/api/mewclaw-desktop/location`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ location: 'cloud' }),
      });
      expect(switchedCloud.status).toBe(200);
      expect(await (await fetch(base)).text()).toContain('__MEWCLAW_SESSION_LOCATION__="cloud"');
      expect(server.port).toBeGreaterThan(0);
      fallback();
    } finally {
      await ctx.fiber.dispose();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('本地模式只把云端 Web UI settings 转发到远端', async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => { seen.push(req.url ?? ''); res.end('cloud-settings'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
    const home = await mkdtemp(join(tmpdir(), 'mewclaw-provider-local-'));
    await writeFile(join(home, 'mewclaw-location.json'), '{"location":"local"}\n');
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const ctx = new Context();
    ctx.provide('connection', { requestRejection: () => undefined, authorizeIndex: () => true });
    try {
      await ctx.plugin(Provider, { host: '127.0.0.1', port: 0, cloudOrigin: `http://127.0.0.1:${address.port}`, cloudTimeoutMs: 1000 });
      const server = ctx.webServer;
      const fallback = server.registerFallback((_req, res) => { res.end('local'); });
      const base = `http://127.0.0.1:${server.port}`;
      expect(isCloudSynchronizedPath('/api/dsh-web-ui-settings/describe')).toBe(true);
      expect(isCloudSynchronizedPath('/auth/models')).toBe(true);
      expect(isCloudSynchronizedPath('/auth/models/00000000-0000-4000-8000-000000000001')).toBe(true);
      expect(isCloudSynchronizedPath('/auth/models/00000000-0000-4000-8000-000000000001/default')).toBe(true);
      expect(await (await fetch(`${base}/api/dsh-web-ui-settings/describe`)).text()).toBe('cloud-settings');
      expect(await (await fetch(`${base}/auth/models`)).text()).toBe('cloud-settings');
      expect(await (await fetch(`${base}/auth/models/00000000-0000-4000-8000-000000000001/default`, {
        method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}',
      })).text()).toBe('cloud-settings');
      expect(await (await fetch(`${base}/api/session/test`)).text()).toBe('local');
      expect(seen).toEqual(['/api/dsh-web-ui-settings/describe', '/auth/models', '/auth/models/00000000-0000-4000-8000-000000000001/default']);
      fallback();
    } finally {
      await ctx.fiber.dispose();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });

  it('代理服务包装后仍能转发，并保留本地路由和认证拒绝', async () => {
    const upstream = createServer((_req, res) => res.end('cloud'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
    const home = await mkdtemp(join(tmpdir(), 'mewclaw-provider-'));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const ctx = new Context();
    let denied: number | undefined;
    ctx.provide('connection', {
      requestRejection: () => denied,
      authorizeIndex: () => true,
    });
    try {
      await ctx.plugin(Provider, { host: '127.0.0.1', port: 0, cloudOrigin: `http://127.0.0.1:${address.port}`, cloudTimeoutMs: 1000 });
      const server = ctx.webServer;
      const fallback = server.registerFallback((_req, res) => { res.end('unexpected local'); });
      const local = server.register({ kind: 'exact', path: '/api/desktop/probe', handler: (_req, res) => { res.end('local'); } });
      const base = `http://127.0.0.1:${server.port}`;
      expect(await (await fetch(base)).text()).toBe('cloud');
      expect(await (await fetch(`${base}/api/desktop/probe`)).text()).toBe('local');
      denied = 403;
      expect((await fetch(`${base}/api/session/test`)).status).toBe(403);
      local(); fallback();
    } finally {
      await ctx.fiber.dispose();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
