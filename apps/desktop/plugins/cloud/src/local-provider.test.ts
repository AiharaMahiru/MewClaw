import { Context } from '@deepseek-ai/cordis';
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
