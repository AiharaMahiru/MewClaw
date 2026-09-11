import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { expect, it } from 'vitest';
import { workspaceJournal } from './journal.js';

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
