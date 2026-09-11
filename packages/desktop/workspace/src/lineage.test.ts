import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import { expect, it } from 'vitest';
import { workspaceJournal } from './journal.js';
import { childToolDenial, sessionAncestry } from './lineage.js';

it('没有继承绑定事件的独立子会话也不能绕过父会话本机限制', async () => {
  const ctx = new Context(); await ctx.plugin(SessionStore);
  const parent = ctx.sessions.create(SessionId('parent'));
  const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: process.cwd(), parentSession: parent.id } });
  const journal = workspaceJournal(ctx);
  try {
    const chain = sessionAncestry(ctx, child.id);
    expect(chain).toEqual(['child', 'parent']);
    expect(childToolDenial(chain, journal)).toBeUndefined();
    await journal.write(parent.id, { owner: 'full-scope', mode: 'desktop', generation: 'revision' });
    expect(journal.read(child.id)).toBeUndefined();
    expect(childToolDenial(chain, journal)).toBe('LOCAL_WORKSPACE_CHILD_TOOL_DISABLED');
  } finally { await ctx.fiber.dispose(); }
});
