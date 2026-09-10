import type { SessionOverview } from "../api.js";

function formatTime(value: string | undefined): string {
  if (!value) return "暂无记录";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "暂无记录" : time.toLocaleString("zh-CN", { hour12: false });
}

function TodoList({ session }: { session: Extract<SessionOverview, { exists: true }> }) {
  if (!session.todos.length) return <p className="session-muted">当前没有待办事项。</p>;
  return (
    <ul className="todo-list">
      {session.todos.slice(0, 4).map((todo, index) => (
        <li key={`${todo.status}-${todo.content}-${index}`}>
          <span className={`todo-status ${todo.status}`}>{todo.status}</span>
          <span>{todo.content}</span>
        </li>
      ))}
    </ul>
  );
}

function UsageGrid({ session }: { session: Extract<SessionOverview, { exists: true }> }) {
  const { usage } = session;
  return (
    <dl className="usage-grid">
      <div><dt>运行</dt><dd>{usage.runs}</dd></div>
      <div><dt>模型调用</dt><dd>{usage.modelCalls}</dd></div>
      <div><dt>输入 token</dt><dd>{usage.inputTokens}</dd></div>
      <div><dt>输出 token</dt><dd>{usage.outputTokens}</dd></div>
    </dl>
  );
}

export function SessionSummary({ session }: { session: SessionOverview }) {
  if (!session.exists) {
    return (
      <div className="session-empty">
        <strong>尚无会话</strong>
        <span>该目标尚未产生可读取的持久化投影。</span>
      </div>
    );
  }
  return (
    <div className="session-summary">
      <div className="session-summary-head">
        <span>上次活动</span>
        <time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time>
      </div>
      <TodoList session={session} />
      <UsageGrid session={session} />
    </div>
  );
}
