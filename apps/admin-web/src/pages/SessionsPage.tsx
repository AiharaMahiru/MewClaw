import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  fetchAdminSessions,
  revokeAdminSession,
  type AdminSessionSummary,
} from "../api.js";
import { Badge, Card, FilterBar, MetricStrip, PageHeader, RefreshButton } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";
import { filterSessions, isActiveSession, type SessionFilter } from "../admin-view-model.js";

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function SessionAction(props: { session: AdminSessionSummary; refresh: () => Promise<void>; onError: (message: string) => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!isActiveSession(props.session)) return <span className="adm-row-side">无需操作</span>;
  const revoke = async (): Promise<void> => {
    if (!window.confirm("撤销这个会话？")) return;
    setBusy(true);
    try {
      await revokeAdminSession(props.session.id);
      await props.refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) props.onUnauthorized();
      else props.onError(cause instanceof ApiError ? cause.code : "撤销失败");
    } finally {
      setBusy(false);
    }
  };
  return <button className="adm-btn adm-btn-sm adm-btn-danger" type="button" disabled={busy} onClick={() => void revoke()}><Icon name="close" size={13} /><span>撤销</span></button>;
}

export function SessionsPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [sessions, setSessions] = useState<AdminSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SessionFilter>("active");
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSessions((await fetchAdminSessions()).sessions);
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof ApiError ? cause.code : "无法加载会话");
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);
  useEffect(() => { void refresh(); }, [refresh]);
  const visible = useMemo(() => filterSessions(sessions, query, filter), [filter, query, sessions]);
  const active = sessions.filter(isActiveSession).length;
  const revoked = sessions.filter((session) => Boolean(session.revokedAt)).length;
  const users = new Set(sessions.map((session) => session.userId)).size;

  return <>
    <PageHeader title="登录会话" sub="账号访问控制" actions={<RefreshButton busy={loading} label="刷新会话" onClick={() => void refresh()} />} />
    {error && <p className="adm-notice adm-notice-err">{error}</p>}
    <MetricStrip label="会话摘要" items={[
      { label: "活跃会话", value: String(active), detail: `共 ${sessions.length} 个会话`, tone: "success", icon: "sessions" },
      { label: "访问用户", value: String(users), detail: "拥有登录记录的账号", tone: "accent", icon: "users" },
      { label: "已撤销", value: String(revoked), detail: "主动终止", icon: "close" },
      { label: "已过期", value: String(sessions.length - active - revoked), detail: "自然到期", icon: "sessions" },
    ]} />
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索姓名或邮箱" selected={filter} onSelect={(value) => setFilter(value as SessionFilter)} resultCount={visible.length} options={[
      { id: "active", label: "活跃" }, { id: "all", label: "全部" }, { id: "inactive", label: "已结束" },
    ]} />
    <Card title="会话记录" meta={`${visible.length} 项`}>
      <div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>用户</th><th>状态</th><th>创建时间</th><th>最近活动</th><th>过期时间</th><th>操作</th></tr></thead>
        <tbody>{visible.map((session) => <tr key={session.id}>
          <td><strong>{session.displayName}</strong><span className="adm-sub">{session.email}</span></td>
          <td><Badge tone={isActiveSession(session) ? "ok" : session.revokedAt ? "err" : undefined}>{isActiveSession(session) ? "活跃" : session.revokedAt ? "已撤销" : "已过期"}</Badge></td>
          <td>{date(session.createdAt)}</td><td>{date(session.lastSeenAt)}</td><td>{date(session.expiresAt)}</td>
          <td><SessionAction session={session} refresh={refresh} onError={setError} onUnauthorized={onUnauthorized} /></td>
        </tr>)}{!visible.length && !loading && <tr><td className="adm-empty" colSpan={6}>暂无会话</td></tr>}{loading && <tr><td className="adm-empty" colSpan={6}><span className="adm-spinner" /> 正在读取会话</td></tr>}</tbody>
      </table></div>
    </Card>
  </>;
}
