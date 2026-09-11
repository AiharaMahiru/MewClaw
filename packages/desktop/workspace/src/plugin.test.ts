import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as plugin from './index.js';

it('真实插件装配校验凭证与会话云端根，sync不能指定任意服务器目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewclaw-plugin-'));
  const ctx = new Context();
  await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools, { mode: 'native' });
  const scope = { tenantId: 'dsh-web', botId: 'dsh-web', deploymentId: 'auth-edge', userId: 'alice', conversationId: 'sync-session' };
  const routes: Array<{ handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }> = [];
  ctx.reflect.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }) });
  ctx.reflect.provide('webServer', { tapIndex: () => () => {}, register: (route: typeof routes[number]) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1); }; } });
  ctx.reflect.provide('sessionPersistence', {}); ctx.reflect.provide('larkScopeIndex', { get: () => scope });
  ctx.sessions.create(SessionId(scope.conversationId), { meta: { cwd: root } });
  const fiber = ctx.plugin(plugin, { enabled: true, tokenRef: 'fixture-token', requestTimeoutMs: 1000, heartbeatTimeoutMs: 3000, maxBindings: 2 });
  await fiber;
  const server = createServer(routes[0]!.handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (command: unknown, rootPath = root, token = 'fixture-token') => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: JSON.stringify({ scope, rootPath, command }) });
  try {
    expect((await post({ action: 'status', sessionId: scope.conversationId }, root, 'bad')).status).toBe(401);
    const identity = { sessionId: scope.conversationId, generation: 'desktop-generation-fixture' };
    expect((await post({ ...identity, action: 'bind', revision: '' })).status).toBe(200);
    const write = { ...identity, action: 'sync', operation: { action: 'write', path: 'test.bin', expected: null, data: Buffer.from([0, 1, 255]).toString('base64') } };
    expect(await (await post(write, tmpdir())).json()).toEqual({ error: 'WORKSPACE_SYNC_ROOT_MISMATCH' });
    expect((await post(write)).status).toBe(200);
    expect(await readFile(join(root, 'test.bin'))).toEqual(Buffer.from([0, 1, 255]));
    expect(await (await post({ ...write, generation: 'old-generation-fixture' })).json()).toEqual({ error: 'WORKSPACE_BINDING_MISMATCH' });
    await fiber.dispose(); expect(routes).toHaveLength(0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true });
  }
});
