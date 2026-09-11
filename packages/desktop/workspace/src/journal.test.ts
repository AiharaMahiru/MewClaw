import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { expect, it } from 'vitest';
import { workspaceJournal } from './journal.js';

it('切回云端落盘失败后拒绝读取新状态，不能回退到服务器执行', async () => {
  const ctx = new Context(); await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId('workspace-journal-failure'));
  const journal = workspaceJournal(ctx);
  try {
    await journal.write(session.id, { owner: 'scope', mode: 'desktop', generation: 'first' });
    ctx.on('session/flush', async () => { throw new Error('fixture disk failure'); });
    await expect(journal.write(session.id, { owner: 'scope', mode: 'cloud', generation: 'second' })).rejects.toThrow('fixture disk failure');
    expect(() => journal.read(session.id)).toThrow('WORKSPACE_PERSISTENCE_UNAVAILABLE');
  } finally { await ctx.fiber.dispose(); }
});

it('绑定事实进入真实Session日志并等待官方flush完成', async () => {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const session = ctx.sessions.create(SessionId('workspace-journal-test'));
  const journal = workspaceJournal(ctx);
  const flushed: unknown[] = [];
  ctx.on('session/flush', async target => { flushed.push(target.snapshotEvents()); });
  try {
    const state = { owner: '["tenant","bot","deployment","user","session"]', mode: 'desktop' as const, generation: 'public-generation' };
    await journal.write(session.id, state);
    expect(journal.read(session.id)).toEqual(state);
    expect(flushed).toHaveLength(1);
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'desktop/workspace', data: state });
    await journal.write(session.id, { ...state, mode: 'cloud' });
    expect(journal.read(session.id)?.mode).toBe('cloud');
  } finally { await ctx.fiber.dispose(); }
});
