import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import { z } from 'zod';
import type { WorkspaceJournal, WorkspaceState } from './broker.js';
import 'dsh-lark-contracts';

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** 最近一次 `desktop/workspace` 绑定事实；宿主侧单元，不下发客户端快照。 */
    desktopWorkspaceState: WorkspaceState | null;
  }
}

const workspaceStateSchema = z.object({
  owner: z.string(),
  mode: z.enum(['cloud', 'desktop']),
  generation: z.string(),
}).nullable();

export function workspaceJournal(ctx: Context): WorkspaceJournal {
  const failed = new Set<string>();
  ctx.sessionProjections.register({
    key: 'desktopWorkspaceState',
    stateSchema: workspaceStateSchema,
    init: () => null,
    apply: (state, event) => event.type === 'desktop/workspace' ? event.data : state,
    stateVersion: 1,
  });
  const session = (id: string) => {
    if (failed.has(id)) throw new Error('WORKSPACE_PERSISTENCE_UNAVAILABLE');
    const value = ctx.sessions.get(SessionId(id));
    if (!value) throw new Error('WORKSPACE_SESSION_NOT_LOADED');
    return value;
  };
  return {
    read(id) {
      const data = ctx.sessionProjections.stateOf(session(id), 'desktopWorkspaceState');
      if (data === undefined || data === null) return undefined;
      if (typeof data.owner !== 'string' || !data.owner || !['cloud', 'desktop'].includes(data.mode) || typeof data.generation !== 'string' || !data.generation) throw new Error('WORKSPACE_STATE_INVALID');
      return data;
    },
    async write(id, state) {
      const target = session(id);
      target.append('desktop/workspace', state);
      try { await ctx.sessions.flush(target); }
      catch (error) { failed.add(id); throw error; }
    },
  };
}
