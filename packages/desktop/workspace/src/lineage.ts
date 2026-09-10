import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WorkspaceJournal } from './broker.js';

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
