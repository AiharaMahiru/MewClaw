import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { proxyDesktopWorkspace } from './desktop-workspace.js';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function listen(server: Server): Promise<string> {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
it('账号与云端根来自认证存储，伪造 Scope 与跨账号在转发前拒绝', async () => {
  const requests: unknown[] = [];
  const worker = await listen(createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.end(JSON.stringify({ ok: true }));
  }));
  const edge = await listen(createServer((req, res) => { void proxyDesktopWorkspace(req, res, {
    userId: 'alice', workerBaseUrl: worker, workerToken: 'fixture-token', requestBodyLimit: 4096,
    findResource: async (_type, id) => ({ userId: id === 'own' ? 'alice' : 'bob', resourcePath: '/owned/cloud' }),
  }); }));
  const post = (body: unknown) => fetch(edge, { method: 'POST', body: JSON.stringify(body) });
  expect((await post({ action: 'status', sessionId: 'other' })).status).toBe(403);
  expect((await post({ action: 'status', sessionId: 'own', userId: 'bob' })).status).toBe(400);
  expect((await post({ action: 'status', sessionId: 'own', rootPath: '/etc' })).status).toBe(400);
  expect((await post({ action: 'status', sessionId: 'own' })).status).toBe(200);
  expect(requests).toEqual([{ command: { action: 'status', sessionId: 'own' }, rootPath: '/owned/cloud',
    scope: { tenantId: 'dsh-web', botId: 'dsh-web', deploymentId: 'auth-edge', userId: 'alice', conversationId: 'own' } }]);
});
it('缺少凭证与超限响应明确失败，不返回部分内容', async () => {
  const worker = await listen(createServer((_req, res) => { res.end('x'.repeat(8192)); }));
  const edge = await listen(createServer((req, res) => { void proxyDesktopWorkspace(req, res, {
    userId: 'alice', workerBaseUrl: worker, workerToken: req.url === '/missing' ? undefined : 'fixture', requestBodyLimit: 1024,
    findResource: async () => ({ userId: 'alice' }),
  }); }));
  const body = JSON.stringify({ action: 'status', sessionId: 'own' });
  expect((await fetch(edge + '/missing', { method: 'POST', body })).status).toBe(503);
  const response = await fetch(edge, { method: 'POST', body }); expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'WORKSPACE_BRIDGE_UNAVAILABLE' });
});

it('桌面取消会关闭向Worker的在途传输', async () => {
  let started = false, closed = false;
  const worker = await listen(createServer((_req, res) => { started = true; res.once('close', () => { closed = true; }); }));
  const edge = await listen(createServer((req, res) => { void proxyDesktopWorkspace(req, res, {
    userId: 'alice', workerBaseUrl: worker, workerToken: 'fixture', requestBodyLimit: 4096,
    findResource: async () => ({ userId: 'alice' }),
  }); }));
  const abort = new AbortController();
  const pending = fetch(edge, { method: 'POST', signal: abort.signal, body: JSON.stringify({ action: 'status', sessionId: 'own' }) }).catch(() => undefined);
  await expect.poll(() => started).toBe(true); abort.abort(); await pending;
  await expect.poll(() => closed).toBe(true);
});
