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
  ctx.provide('sessions', { get: (id: string) => ({ header: { cwd: id === 'unbound' ? undefined : root } }) });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const workspaces = new LocalHarnessWorkspaces(ctx, { maxBytes: 1024, maxEntries: 20 });
  const signal = new AbortController().signal;
  try {
    expect(await workspaces.pick()).toBeNull();
    await expect(workspaces.execute('unbound', { action: 'list', path: '.' }, signal)).rejects.toThrow(/LOCAL_WORKSPACE_NOT_AUTHORIZED.*未绑定本地目录/);
    await expect(workspaces.execute('session', { action: 'list', path: '.' }, signal)).rejects.toThrow(/LOCAL_WORKSPACE_NOT_AUTHORIZED.*授权已失效.*打开本地目录/);
    selected = root;
    expect(await workspaces.pick()).toMatchObject({ workspaceId: 'workspace' });
    await workspaces.execute('session', { action: 'write', path: 'hello.txt', content: '本地 Harness' }, signal);
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('本地 Harness');
    await expect(workspaces.execute('session', { action: 'read', path: '../outside' }, signal)).rejects.toThrow('LOCAL_PATH_NOT_ALLOWED');
    workspaces.dispose();
    await expect(workspaces.execute('session', { action: 'list', path: '.' }, signal)).rejects.toThrow(/LOCAL_WORKSPACE_NOT_AUTHORIZED.*授权已失效/);
  } finally { workspaces.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

it.each(['picker', 'registry'])('在 %s 等待期间撤销后，旧操作不能恢复目录授权', async (stage) => {
  const root = await mkdtemp(join(tmpdir(), '本地 工作区-'));
  const ctx = new Context();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const wait = async (value: string) => { if (stage === value) { entered.resolve(); await resume.promise; } };
  ctx.provide('desktopRuntime', { pickDirectory: async () => { await wait('picker'); return root; } });
  ctx.provide('workspaceRegistry', { create: async () => { await wait('registry'); return { id: 'workspace' }; } });
  ctx.provide('sessions', { get: () => ({ header: { cwd: root } }) });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const workspaces = new LocalHarnessWorkspaces(ctx, { maxBytes: 1024, maxEntries: 20 });
  try {
    const picking = workspaces.pick();
    await entered.promise;
    workspaces.dispose();
    resume.resolve();
    await expect(picking).rejects.toThrow('LOCAL_WORKSPACE_AUTHORIZATION_REVOKED');
    await expect(workspaces.execute('session', { action: 'list', path: '.' }, new AbortController().signal))
      .rejects.toThrow('LOCAL_WORKSPACE_NOT_AUTHORIZED');
    expect(await workspaces.pick()).toMatchObject({ workspaceId: 'workspace' });
    await workspaces.execute('session', { action: 'write', path: '中文 文件.txt', content: '重新授权' }, new AbortController().signal);
    expect(await readFile(join(root, '中文 文件.txt'), 'utf8')).toBe('重新授权');
  } finally { resume.resolve(); workspaces.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

it('本地目录入口保留 preset 工具目录，不再替换为专用文件工具', async () => {
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
    expect(catalog({ scope: agent }).schemas.map(tool => tool.name)).toEqual(['unrestricted_test']);
    expect(catalog({}).schemas.map(tool => tool.name)).toContain('unrestricted_test');
  } finally { await scope.dispose(); await ctx.fiber.dispose(); }
});
