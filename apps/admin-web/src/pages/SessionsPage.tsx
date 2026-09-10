import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  fetchAdminSessions,
  revokeAdminSession,
  type AdminSessionSummary,
} from "../api.js";
import { FilterBar, MetricStrip, PageHeader, RefreshButton, SectionHeading } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";
import { filterSessions, isActiveSession, type SessionFilter } from "../admin-view-model.js";

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function isActive(session: AdminSessionSummary): boolean {
  return isActiveSession(session);
}

function SessionAction(props: { session: AdminSessionSummary; refresh: () => Promise<void>; onError: (message: string) => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!isActive(props.session)) return <span className="table-muted">无需操作</span>;
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
  return <button type="button" disabled={busy} onClick={() => void revoke()}><Icon name="close" size={13} /><span>撤销</span></button>;
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
  const active = sessions.filter(isActive).length;
  const revoked = sessions.filter((session) => Boolean(session.revokedAt)).length;
  const users = new Set(sessions.map((session) => session.userId)).size;

  return <section className="workspace">
    <PageHeader eyebrow="访问控制" title="登录会话" actions={<RefreshButton busy={loading} label="刷新会话" onClick={() => void refresh()} />} />
    {error && <p className="notice error">{error}</p>}
    <MetricStrip label="会话摘要" items={[
      { label: "活跃会话", value: String(active), detail: `共 ${sessions.length} 个会话`, tone: "success", icon: "sessions" },
      { label: "访问用户", value: String(users), detail: "拥有登录记录的账号", tone: "accent", icon: "users" },
      { label: "已撤销", value: String(revoked), detail: "主动终止", icon: "close" },
      { label: "已过期", value: String(sessions.length - active - revoked), detail: "自然到期", icon: "sessions" },
    ]} />
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索姓名或邮箱" selected={filter} onSelect={(value) => setFilter(value as SessionFilter)} resultCount={visible.length} options={[
      { id: "active", label: "活跃" }, { id: "all", label: "全部" }, { id: "inactive", label: "已结束" },
    ]} />
    <section className="section-block">
      <SectionHeading title="会话记录" meta={`${visible.length} 项`} />
      <div className="table-scroll"><table className="data-table admin-table"><thead><tr><th>用户</th><th>状态</th><th>创建时间</th><th>最近活动</th><th>过期时间</th><th>操作</th></tr></thead>
        <tbody>{visible.map((session) => <tr key={session.id}>
          <td data-label="用户"><strong>{session.displayName}</strong><span className="table-subline">{session.email}</span></td>
          <td data-label="状态"><span className={`badge ${isActive(session) ? "active" : "revoked"}`}>{isActive(session) ? "活跃" : session.revokedAt ? "已撤销" : "已过期"}</span></td>
          <td data-label="创建时间">{date(session.createdAt)}</td><td data-label="最近活动">{date(session.lastSeenAt)}</td><td data-label="过期时间">{date(session.expiresAt)}</td>
          <td data-label="操作"><SessionAction session={session} refresh={refresh} onError={setError} onUnauthorized={onUnauthorized} /></td>
        </tr>)}{!visible.length && !loading && <tr><td className="empty" colSpan={6}>暂无会话</td></tr>}</tbody>
      </table></div>
    </section>
  </section>;
}
