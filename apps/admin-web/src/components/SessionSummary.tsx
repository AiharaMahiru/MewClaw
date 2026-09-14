import type { SessionOverview } from "../api.js";
import { Badge, Empty } from "./AdminUi.js";

function formatTime(value: string | undefined): string {
  if (!value) return "暂无记录";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "暂无记录" : time.toLocaleString("zh-CN", { hour12: false });
}

const TODO_TONE: Record<string, "ok" | "info" | "warn"> = { completed: "ok", in_progress: "info", pending: "warn" };

export function SessionSummary({ session }: { session: SessionOverview }) {
  if (!session.exists) {
    return <Empty><strong>尚无会话</strong><span>该目标尚未产生可读取的持久化投影。</span></Empty>;
  }
  return <div className="adm-session">
    <div className="adm-session-head"><span>上次活动</span><time dateTime={session.lastActivityAt}>{formatTime(session.lastActivityAt)}</time></div>
    {session.todos.length ? <ul className="adm-todos">{session.todos.slice(0, 4).map((todo, index) => <li key={`${todo.status}-${index}`}><Badge tone={TODO_TONE[todo.status]}>{todo.status}</Badge><span>{todo.content}</span></li>)}</ul> : <Empty>当前没有待办事项。</Empty>}
    <dl className="adm-usage">
      <div><dt>运行</dt><dd>{session.usage.runs}</dd></div>
      <div><dt>模型调用</dt><dd>{session.usage.modelCalls}</dd></div>
      <div><dt>输入 token</dt><dd>{session.usage.inputTokens}</dd></div>
      <div><dt>输出 token</dt><dd>{session.usage.outputTokens}</dd></div>
    </dl>
  </div>;
}
