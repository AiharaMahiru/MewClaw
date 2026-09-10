import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { TodoItem } from "@deepseek-ai/dsh-tool-todo";
import type { SessionPersistence } from "@deepseek-ai/dsh-session-persistence";
import { inspectStoredSession, type LarkSessionDirectory } from "dsh-lark-session-directory";

import {
  deterministicSessionIdForScope,
  type Scope,
  type SessionOverview,
  type SessionOverviewRequest,
  type SessionOverviewUsage,
} from "dsh-lark-contracts";

const EMPTY_USAGE: SessionOverviewUsage = {
  runs: 0,
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** 完整 Scope 与代次确定性映射为唯一 DSH session id。 */
export function sessionIdForScope(scope: Scope, generation: number): SessionId {
  return SessionId(deterministicSessionIdForScope(scope, generation));
}

function addUsage(total: SessionOverviewUsage, event: SessionEvent): void {
  if (event.type === "turn/start") total.runs += 1;
  if (event.type !== "assistant/message") return;
  total.modelCalls += 1;
  const usage = event.data.usage;
  if (!usage) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens ?? 0;
  total.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  total.reasoningTokens += usage.reasoningTokens ?? 0;
}

function project(events: readonly SessionEvent[]): Omit<Extract<SessionOverview, { exists: true }>, "exists"> {
  const usage = { ...EMPTY_USAGE };
  let todos: TodoItem[] = [];
  let lastActivity = 0;
  for (const event of events) {
    addUsage(usage, event);
    // dsh-tool-todo 的插件事件在 alpha5 中通过运行时已知类型注册，未并入
    // dsh-session 的静态 SessionEventMap；这里用窄化读取保持回放兼容。
    if ((event.type as string) === "todo/write") {
      const data = (event as unknown as { data?: { todos?: unknown } }).data;
      if (Array.isArray(data?.todos)) todos = [...data.todos] as TodoItem[];
    }
    lastActivity = Math.max(lastActivity, event.time);
  }
  return {
    todos,
    usage,
    ...(lastActivity > 0 ? { lastActivityAt: new Date(lastActivity).toISOString() } : {}),
  };
}

/** 只在精确 session id 已物化时读取；不存在统一返回 exists=false。 */
export async function readSessionOverview(
  persistence: SessionPersistence,
  directory: Pick<LarkSessionDirectory, "resolve">,
  input: SessionOverviewRequest,
): Promise<SessionOverview> {
  const target = await directory.resolve(input);
  const sessionId = target.mode === "shared"
    ? target.sessionId
    : sessionIdForScope(input.scope, input.sessionGeneration);
  const snapshots = await persistence.list();
  if (!snapshots.some((snapshot) => snapshot.header.id === sessionId)) return { exists: false };
  const inspection = await inspectStoredSession(persistence, sessionId);
  return { exists: true, ...project(inspection.events) };
}
