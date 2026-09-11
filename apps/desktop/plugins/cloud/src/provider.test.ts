import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { createServer } from 'node:http';
import Provider from './index.js';

describe('真实 Cordis Provider 注册', () => {
  it('代理服务包装后仍能转发，并保留本地路由和认证拒绝', async () => {
    const upstream = createServer((_req, res) => res.end('cloud'));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
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
    }
  });
});
