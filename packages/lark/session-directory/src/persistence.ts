/** 通过官方只读句柄取得完整日志；任何成功或失败路径均释放句柄。 */
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionInspection, SessionPersistence } from "@deepseek-ai/dsh-session-persistence";

export async function inspectStoredSession(
  persistence: Pick<SessionPersistence, "open">,
  sessionId: SessionId,
): Promise<SessionInspection> {
  const handle = await persistence.open(sessionId, "read");
  try {
    const { events } = await handle.read();
    return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events };
  } finally {
    await handle.close();
  }
}
