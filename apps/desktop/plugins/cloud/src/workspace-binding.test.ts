import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalWorkspaceBinding } from './workspace-binding.js';

it('本机授权绑定拒绝跨账号、跨会话、旧代次及断线后的执行', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mewclaw-binding-'));
  const root = join(parent, 'workspace');
  await mkdir(root);
  const ctx = new Context();
  await ctx.plugin(LocalFileSystem, { cwd: root });
  const local = new LocalWorkspaceBinding(ctx.fs, { maxBytes: 1024, maxEntries: 10 });
  const identity = { accountId: 'account-a', sessionId: 'session-a' };
  const signal = new AbortController().signal;
  try {
    const binding = (await local.authorize(identity, async () => root))!;
    expect(binding).not.toHaveProperty('path');
    const request = { ...binding, operation: { action: 'list', path: '.' } };
    expect(await local.execute(request, signal)).toMatchObject({ location: 'desktop', entries: [] });
    for (const change of [{ accountId: 'account-b' }, { sessionId: 'session-b' }, { generation: 'old' }]) {
      await expect(local.execute({ ...request, ...change }, signal)).rejects.toThrow('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
    }
    expect(await local.authorize(identity, async () => null)).toBeNull();
    expect(await local.execute(request, signal)).toMatchObject({ location: 'desktop' });
    local.revoke();
    await expect(local.execute(request, signal)).rejects.toThrow('LOCAL_WORKSPACE_DISCONNECTED');
    await local.authorize(identity, async () => root);
    await expect(local.execute(request, signal)).rejects.toThrow('LOCAL_WORKSPACE_IDENTITY_MISMATCH');
  } finally {
    local.revoke(); await ctx.fiber.dispose(); await rm(parent, { recursive: true, force: true });
  }
});
