import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceJournal, WorkspaceState } from './broker.js';
import 'dsh-lark-contracts';
export function workspaceJournal(ctx: Context): WorkspaceJournal {
  const failed = new Set<string>();
  const session = (id: string) => {
    if (failed.has(id)) throw new Error('WORKSPACE_PERSISTENCE_UNAVAILABLE');
    const value = ctx.sessions.get(SessionId(id));
    if (!value) throw new Error('WORKSPACE_SESSION_NOT_LOADED');
    return value;
  };
  return {
    read(id) {
      const events = session(id).snapshotEvents();
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!;
        if (event.type === 'desktop/workspace') {
          const data = event.data as WorkspaceState;
          if (!data || typeof data.owner !== 'string' || !data.owner || !['cloud', 'desktop'].includes(data.mode) || typeof data.generation !== 'string' || !data.generation) throw new Error('WORKSPACE_STATE_INVALID');
          return data;
        }
      }
      return undefined;
    },
    async write(id, state) {
      const target = session(id);
      target.append('desktop/workspace', state);
      try { await ctx.sessions.flush(target); }
      catch (error) { failed.add(id); throw error; }
    },
  };
}
