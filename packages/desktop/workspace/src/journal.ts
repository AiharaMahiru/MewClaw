import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceJournal, WorkspaceState } from './broker.js';
import 'dsh-lark-contracts';
export function workspaceJournal(ctx: Context): WorkspaceJournal {
  const session = (id: string) => {
    const value = ctx.sessions.get(SessionId(id));
    if (!value) throw new Error('WORKSPACE_SESSION_NOT_LOADED');
    return value;
  };
  return {
    read(id) {
      const events = session(id).snapshotEvents();
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type === 'desktop/workspace') return event.data as WorkspaceState;
      }
      return undefined;
    },
    async write(id, state) {
      const target = session(id);
      target.append('desktop/workspace', state);
      await ctx.sessions.flush(target);
    },
  };
}
