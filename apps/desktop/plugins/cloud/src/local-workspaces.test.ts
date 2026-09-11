import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalHarnessWorkspaces } from './local-workspaces.js';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import type { Agent } from '@deepseek-ai/dsh-agent';

it('本机授权与工具执行不访问云端，取消、越界和撤销明确拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mewclaw-local-harness-'));
  const ctx = new Context();
  let selected: string | null = null;
  ctx.provide('desktopRuntime', { pickDirectory: async () => selected });
  ctx.provide('workspaceRegistry', { create: async () => ({ id: 'workspace' }) });
  ctx.provide('sessions', { get: () => ({ header: { cwd: root } }) });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const workspaces = new LocalHarnessWorkspaces(ctx, { maxBytes: 1024, maxEntries: 20 });
  const signal = new AbortController().signal;
  try {
    expect(await workspaces.pick()).toBeNull();
    await expect(workspaces.execute('session', { action: 'list', path: '.' }, signal)).rejects.toThrow('LOCAL_WORKSPACE_NOT_AUTHORIZED');
    selected = root;
    expect(await workspaces.pick()).toMatchObject({ workspaceId: 'workspace' });
    await workspaces.execute('session', { action: 'write', path: 'hello.txt', content: '本地 Harness' }, signal);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('本地 Harness');
    await expect(workspaces.execute('session', { action: 'read', path: '../outside' }, signal)).rejects.toThrow('LOCAL_PATH_NOT_ALLOWED');
    workspaces.dispose();
    await expect(workspaces.execute('session', { action: 'list', path: '.' }, signal)).rejects.toThrow('LOCAL_WORKSPACE_NOT_AUTHORIZED');
  } finally { workspaces.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('新建本地Agent的实际工具目录只包含已授权文件工具', async () => {
  const ctx = new Context();
  let catalog!: (context: { scope?: object }) => { schemas: Array<{ name: string }> };
  ctx.provide('systemPrompt', { tools: (render: typeof catalog) => { catalog = render; } });
  await ctx.plugin(Tools);
  ctx.tools.register(defineTool({ name: 'unrestricted_test', description: 'unrestricted', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: () => '' }));
  const workspaces = new LocalHarnessWorkspaces(ctx, { maxBytes: 1024, maxEntries: 20 });
  workspaces.install(ctx);
  const agent = { ctx } as Agent;
  const scope = createScope(ctx, agent);
  Object.assign(agent, { ctx: scope.ctx });
  try {
    ctx.emit(scopeTarget(agent, agent), 'agent/created', { agent });
    expect(catalog({ scope: agent }).schemas.map(tool => tool.name)).toEqual(['desktop_workspace']);
    expect(catalog({}).schemas.map(tool => tool.name)).toContain('unrestricted_test');
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});
