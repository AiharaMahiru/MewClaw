import { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Provider from './index.js';

it('本地会话API在云端完全不可达时仍由官方本机handler处理', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mewclaw-provider-local-'));
  await writeFile(join(home, 'mewclaw-location.json'), JSON.stringify({ location: 'local' }));
  vi.stubEnv('DSH_HOME', home);
  const ctx = new Context();
  ctx.provide('connection', { requestRejection: () => undefined, authorizeIndex: () => true });
  try {
    await ctx.plugin(Provider, { host: '127.0.0.1', port: 0, cloudOrigin: 'http://127.0.0.1:1', cloudTimeoutMs: 1000 });
    ctx.webServer.register({ kind: 'exact', path: '/api/session/test', handler: (_req, res) => res.end('local-session-list') });
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    expect(await (await fetch(base + '/api/session/test')).text()).toBe('local-session-list');
    expect(await (await fetch(base + '/api/mewclaw-desktop/location')).json()).toEqual({ location: 'local' });
    const bridge = await fetch(base + '/api/mewclaw-desktop/workspace', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'desktop', sessionId: 'cloud-session' }) });
    expect(bridge.status).toBe(409);
    expect(await bridge.text()).toBe('CLOUD_WORKSPACE_DISABLED_IN_LOCAL_MODE');
  } finally { await ctx.fiber.dispose(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});

it('本地模式下观察到会话 cookie 建立后重排默认模型并扩展桥接路由', async () => {
  const modelRequests: string[] = [];
  const upstream = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/auth/models')) {
      modelRequests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ profiles: [], defaultProfileId: null,
        sharedModels: [{ provider: 'deepseek-official', model: 'smoke-v1', name: 'Smoke V1' }] }));
      return;
    }
    res.writeHead(404); res.end('{"error":"NOT_FOUND"}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const home = await mkdtemp(join(tmpdir(), 'mewclaw-provider-resync-'));
  await writeFile(join(home, 'mewclaw-location.json'), JSON.stringify({ location: 'local' }));
  vi.stubEnv('DSH_HOME', home);
  const ctx = new Context();
  ctx.provide('connection', { requestRejection: () => undefined, authorizeIndex: () => true });
  let routes: string[] = [];
  const registered = new Set<string>();
  const current = { provider: 'deepseek-official', model: 'deepseek-flash' };
  const saved: { provider: string; model: string }[] = [];
  ctx.provide('llm', {
    registerAdapter: (providers: string[]) => {
      routes = providers;
      const handle = Object.assign(() => { for (const id of routes) registered.delete(id); }, {
        replace: (next: string[]) => { for (const id of routes) registered.delete(id); routes = next; for (const id of next) registered.add(id); },
      });
      for (const id of providers) registered.add(id);
      return handle;
    },
    listProviders: () => [...registered].map(id => ({ id, name: id })),
  });
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ ...current }),
    saveSelection: async (next: { provider: string; model: string }) => { saved.push({ ...next }); current.provider = next.provider; current.model = next.model; },
  });
  try {
    await ctx.plugin(Provider, { host: '127.0.0.1', port: 0, cloudOrigin: 'http://127.0.0.1:1',
      cloudModelOrigin: `http://127.0.0.1:${address.port}`, cloudTimeoutMs: 1000 });
    ctx.webServer.register({ kind: 'exact', path: '/api/session/test', handler: (_req, res) => res.end('local') });
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    await vi.waitFor(() => expect(saved).toContainEqual({ provider: 'mewclaw-cloud', model: 'cloud-default' }), { timeout: 5000 });
    await fetch(`${base}/api/session/test`);
    expect(modelRequests).toHaveLength(0);
    await fetch(`${base}/api/session/test`, { headers: { cookie: 'dsh_session=t; dsh_csrf=c' } });
    await vi.waitFor(() => expect(modelRequests.length).toBeGreaterThan(0), { timeout: 5000 });
    await vi.waitFor(() => expect(saved.at(-1)).toEqual({ provider: 'deepseek-official', model: 'smoke-v1' }), { timeout: 5000 });
    expect(routes).toEqual(expect.arrayContaining(['web-private', 'deepseek-official', 'mewclaw-cloud']));
  } finally {
    await ctx.fiber.dispose();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
