import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import { expect, it } from 'vitest';
import * as workspace from './index.js';
import { workspaceJournal } from './journal.js';

it('真实Tools运行时阻止父子会话的云端工具，后续allow策略不能重新放行', async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools, { mode: 'native' });
  const scope = { tenantId: 'dsh-web', botId: 'dsh-web', deploymentId: 'auth-edge', userId: 'a', conversationId: 'parent' };
  ctx.reflect.provide('credentials', { resolve: async () => ({ value: 'fixture-token' }) });
  ctx.reflect.provide('webServer', { register: () => () => {} });
  ctx.reflect.provide('sessionPersistence', {});
  ctx.reflect.provide('larkScopeIndex', { get: () => scope });
  const fiber = ctx.plugin(workspace, { tokenRef: 'test', requestTimeoutMs: 1000, heartbeatTimeoutMs: 3000, maxBindings: 10 });
  await fiber;
  const parent = ctx.sessions.create(SessionId('parent'));
  const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: process.cwd(), parentSession: parent.id } });
  let executions = 0;
  ctx.tools.register(defineTool({ name: 'cloud_probe', description: 'fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { executions++; return 'executed'; } }));
  const execute = (session: typeof parent) => ctx.tools.execute({ name: 'cloud_probe', callId: 'fixture-call' as never, arguments: {},
    agent: ctx.extend({ id: session.id, session }) as never, signal: new AbortController().signal });
  try {
    await execute(parent); expect(executions).toBe(1);
    await workspaceJournal(ctx).write(parent.id, { owner: JSON.stringify(Object.values(scope)), mode: 'desktop', generation: 'public-revision' });
    ctx.on('tools/pre-execute', async (_exec, next) => next());
    await execute(parent); await execute(child);
    expect(executions).toBe(1);
    await fiber.dispose();
  } finally { await ctx.fiber.dispose(); }
});
