import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceJournal } from './broker.js';
import type { WorkspaceState } from './broker.js';
import type {} from '@deepseek-ai/dsh-session-persistence';

/** 为本次工具请求读取父链；卸载的普通云端父会话不是拒绝理由。 */
export async function prepareLineage(ctx: Context, id: string, journal: WorkspaceJournal, signal: AbortSignal): Promise<{ chain: string[]; journal: WorkspaceJournal }> {
  const chain: string[] = [], archived = new Map<string, WorkspaceState | undefined>();
  let current: string | undefined = id;
  while (current !== undefined) {
    signal.throwIfAborted();
    if (chain.includes(current)) throw new Error('WORKSPACE_LINEAGE_INVALID');
    chain.push(current);
    const live = ctx.sessions.get(SessionId(current));
    if (live) { current = live.header.parentSession; continue; }
    const handle = await ctx.sessionPersistence.open(SessionId(current), 'read', { signal });
    try {
      let state: WorkspaceState | undefined;
      // 分页读取不累计历史正文，只保留最新工作区事件。
      for (let offset = 0; ; offset += 128) {
        const page = await handle.read(offset, 128, { signal });
        for (const event of page.events) if (event.type === 'desktop/workspace') {
          const value = event.data;
          if (!value || typeof value.owner !== 'string' || !['cloud', 'desktop'].includes(value.mode) || typeof value.generation !== 'string') throw new Error('WORKSPACE_STATE_INVALID');
          state = value;
        }
        if (page.events.length < 128) break;
      }
      archived.set(current, state); current = handle.header.parentSession;
    } finally { await handle.close(); }
  }
  return { chain, journal: {
    // 活跃状态优先，不能用预检快照掩盖随后发生的切换或持久化失败。
    read: sessionId => ctx.sessions.get(SessionId(sessionId)) ? journal.read(sessionId) : archived.get(sessionId),
    write: (sessionId, state) => journal.write(sessionId, state),
  } };
}

/** 父链来自官方持久化header；不接受模型提供的父会话ID。 */
export function sessionAncestry(ctx: Context, id: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined) {
    if (visited.has(current)) throw new Error('WORKSPACE_LINEAGE_INVALID');
    visited.add(current); chain.push(current);
    const session = ctx.sessions.get(SessionId(current));
    if (!session) throw new Error('WORKSPACE_LINEAGE_NOT_LOADED');
    current = session.header.parentSession;
  }
  return chain;
}
export function childToolDenial(chain: string[], journal: WorkspaceJournal): string | undefined {
  if (chain.slice(1).some(id => journal.read(id)?.mode === 'desktop')) return 'LOCAL_WORKSPACE_CHILD_TOOL_DISABLED';
  return undefined;
}
