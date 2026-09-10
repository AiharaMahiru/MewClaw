import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  fetchAdminUsers,
  revokeAdminUserSessions,
  updateAdminUser,
  type AdminMode,
  type AdminRole,
  type AdminUserSummary,
} from "../api.js";
import { FilterBar, MetricStrip, PageHeader, SectionHeading } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";
import { filterUsers, type UserFilter } from "../admin-view-model.js";

type UserPatch = { role: AdminRole; status?: "active" | "disabled"; defaultMode: AdminMode };

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "暂无记录" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function statusLabel(status: AdminUserSummary["status"]): string {
  return status === "active" ? "正常" : status === "disabled" ? "已停用" : "待验证";
}

function modeLabel(mode: AdminUserSummary["defaultMode"]): string {
  return mode === "full" ? "Full / OCI" : "轻量";
}

function actionError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "操作失败，请稍后重试";
  if (cause.code === "CSRF_INVALID") return "页面已过期，请刷新后重试";
  if (cause.code === "LAST_ADMIN_REQUIRED") return "至少保留一个正常管理员";
  if (cause.code === "MODE_NOT_ALLOWED") return "普通用户不能使用 Full / OCI 模式";
  if (cause.code === "USER_NOT_FOUND") return "账号已不存在，请刷新列表";
  if (cause.code === "INVALID_RESPONSE") return "操作已提交，但返回数据异常，请刷新列表";
  if (cause.code === "INTERNAL_ERROR") return "服务暂时不可用，请稍后重试";
  return cause.code;
}

function UserProfile({ user }: { user: AdminUserSummary }) {
  return <div className="user-editor-profile">
    <span className={`user-avatar ${user.role}`} aria-hidden="true">{user.displayName.slice(0, 1).toUpperCase()}</span>
    <div className="user-editor-identity"><strong>{user.displayName}</strong><span>{user.email}</span><div className="user-editor-badges"><span className={`badge ${user.role}`}>{user.role === "admin" ? "管理员" : "成员"}</span><span className={`badge ${user.status}`}>{statusLabel(user.status)}</span></div></div>
  </div>;
}

function UserEditor(props: {
  user: AdminUserSummary | null;
  onClose: () => void;
  onSave: (user: AdminUserSummary, patch: UserPatch) => Promise<void>;
  onRevoke: (user: AdminUserSummary) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [role, setRole] = useState<AdminRole>(props.user?.role ?? "user");
  const [status, setStatus] = useState<"active" | "disabled">(props.user?.status === "disabled" ? "disabled" : "active");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!props.user) return;
    setRole(props.user.role);
    setStatus(props.user.status === "disabled" ? "disabled" : "active");
  }, [props.user]);

  if (!props.user) return <aside className="user-editor user-editor-empty"><div className="editor-empty-icon"><Icon name="edit" size={18} /></div><strong>选择一个账号</strong><span>从列表打开权限表单</span></aside>;

  const user = props.user;
  const effectiveMode: AdminMode = role === "admin" ? "full" : "lightweight";
  const changed = role !== user.role || (user.status !== "pending" && status !== user.status) || effectiveMode !== user.defaultMode;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!changed || saving) return;
    setSaving(true);
    props.onError("");
    try {
      await props.onSave(user, { role, defaultMode: effectiveMode, ...(user.status === "pending" ? {} : { status }) });
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) props.onError(actionError(cause));
    } finally {
      setSaving(false);
    }
  };
  const revoke = async (): Promise<void> => {
    if (!user.sessionCount || saving) return;
    if (!window.confirm("终止这个账号的全部登录会话？用户需要重新登录。")) return;
    setSaving(true);
    props.onError("");
    try {
      await props.onRevoke(user);
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 401)) props.onError(actionError(cause));
    } finally {
      setSaving(false);
    }
  };

  return <aside className="user-editor is-open" aria-label="编辑用户">
    <div className="user-editor-head"><div><span className="editor-kicker">ACCOUNT PROFILE</span><h2>账号设置</h2></div><button className="icon-button" type="button" aria-label="关闭编辑面板" title="关闭" onClick={props.onClose}><Icon name="close" size={17} /></button></div>
    <UserProfile user={user} />
    <form className="user-editor-form" onSubmit={(event) => void submit(event)}>
      <div className="form-section"><div className="form-section-heading"><span>身份与权限</span><small>仅管理员可修改</small></div>
        <div className="editor-field"><span className="editor-label">邮箱地址</span><div className="readonly-field">{user.email}<Icon name="shield" size={14} /></div></div>
        <fieldset className="role-field"><legend className="editor-label">角色</legend><div className="role-options">
          <button className={`role-option ${role === "user" ? "selected" : ""}`} type="button" disabled={user.status === "pending" || saving} onClick={() => setRole("user")}><span className="role-option-icon"><Icon name="users" size={15} /></span><span><strong>成员</strong><small>轻量工作区</small></span>{role === "user" && <Icon name="check" size={15} />}</button>
          <button className={`role-option ${role === "admin" ? "selected" : ""}`} type="button" disabled={user.status === "pending" || saving} onClick={() => setRole("admin")}><span className="role-option-icon"><Icon name="shield" size={15} /></span><span><strong>管理员</strong><small>Full / OCI</small></span>{role === "admin" && <Icon name="check" size={15} />}</button>
        </div></fieldset>
      </div>
      <div className="form-section"><div className="form-section-heading"><span>访问状态</span><small>会话即时生效</small></div>
        {user.status === "pending" ? <div className="pending-field"><span className="status-dot idle" /><span>待完成邮箱验证，暂不可编辑状态</span></div> : <label className="editor-field"><span className="editor-label">账号状态</span><select value={status} disabled={saving} onChange={(event) => setStatus(event.target.value as "active" | "disabled")}><option value="active">正常 · 允许登录</option><option value="disabled">已停用 · 拒绝登录</option></select></label>}
        <div className="mode-field"><span className="editor-label">默认运行模式</span><div className={`mode-display ${effectiveMode}`}><span className="mode-indicator" /><strong>{modeLabel(effectiveMode)}</strong><span>由角色自动决定</span></div></div>
      </div>
      <div className="form-section resource-section"><div className="form-section-heading"><span>资源概览</span><small>只读</small></div><div className="resource-grid"><div><strong>{user.sessionCount}</strong><span>登录会话</span></div><div><strong>{user.workspaceCount}</strong><span>工作区</span></div><div><strong>{user.identityCount}</strong><span>身份绑定</span></div></div></div>
      <div className="user-editor-actions"><button className="primary-action" type="submit" disabled={!changed || saving}><Icon name="check" size={15} /><span>{saving ? "保存中" : "保存修改"}</span></button><button className="secondary-action" type="button" onClick={props.onClose} disabled={saving}>取消</button></div>
    </form>
    <div className="user-editor-danger"><button className="danger-action" type="button" disabled={!user.sessionCount || saving} onClick={() => void revoke()}><Icon name="sessions" size={14} /><span>{user.sessionCount ? `终止 ${user.sessionCount} 个登录会话` : "暂无活跃会话"}</span></button></div>
    <p className="editor-footnote">创建于 {date(user.createdAt)} · 最近更新 {date(user.updatedAt)}</p>
  </aside>;
}

function UsersTable(props: { users: AdminUserSummary[]; loading: boolean; selectedId: string; onEdit: (user: AdminUserSummary) => void }) {
  return <section className="section-block user-list-panel">
    <SectionHeading title="账号目录" meta={`${props.users.length} 个结果`} />
    <div className="table-scroll"><table className="data-table admin-table user-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>默认模式</th><th>资源</th><th>创建时间</th><th aria-label="编辑" /></tr></thead>
      <tbody>{props.users.map((user) => <tr className={user.id === props.selectedId ? "is-selected" : ""} key={user.id} onDoubleClick={() => props.onEdit(user)}>
        <td data-label="用户"><span className="table-user-cell"><span className={`user-avatar mini ${user.role}`}>{user.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName}</strong><span className="table-subline">{user.email}</span></span></span></td>
        <td data-label="角色"><span className={`badge ${user.role}`}>{user.role === "admin" ? "管理员" : "成员"}</span></td>
        <td data-label="状态"><span className={`badge ${user.status}`}>{statusLabel(user.status)}</span></td>
        <td data-label="默认模式"><span className="mode-cell"><span className={`mode-indicator ${user.defaultMode}`} />{modeLabel(user.defaultMode)}</span></td>
        <td data-label="资源"><span className="resource-count">{user.sessionCount} 会话</span><span className="table-subline">{user.workspaceCount} 工作区 · {user.identityCount} 身份</span></td>
        <td data-label="创建时间">{date(user.createdAt)}</td>
        <td data-label="编辑"><button className="table-edit-button" type="button" aria-label={`编辑 ${user.displayName}`} title="编辑账号" onClick={() => props.onEdit(user)}><Icon name="edit" size={14} /><span>编辑</span></button></td>
      </tr>)}{!props.users.length && !props.loading && <tr><td className="empty" colSpan={7}>没有符合条件的用户</td></tr>}{props.loading && <tr><td className="empty loading-row" colSpan={7}><span className="loading-spinner" />正在读取账号目录</td></tr>}</tbody>
    </table></div>
  </section>;
}

export function UsersPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserFilter>("all");
  const [selectedId, setSelectedId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = (await fetchAdminUsers()).users;
      setUsers(next);
      setSelectedId((current) => current && next.some((user) => user.id === current) ? current : next[0]?.id ?? "");
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof ApiError ? cause.code : "无法加载用户");
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { void refresh(); }, [refresh]);

  const visible = useMemo(() => filterUsers(users, query, filter), [filter, query, users]);
  const selected = users.find((user) => user.id === selectedId) ?? null;
  const active = users.filter((user) => user.status === "active").length;
  const pending = users.filter((user) => user.status === "pending").length;
  const admins = users.filter((user) => user.role === "admin").length;
  const resources = users.reduce((total, user) => total + user.workspaceCount, 0);

  const saveUser = async (user: AdminUserSummary, patch: UserPatch): Promise<void> => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await updateAdminUser(user.id, patch);
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      setNotice(`${updated.displayName} 的账号设置已保存`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  const revokeUserSessions = async (user: AdminUserSummary): Promise<void> => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await revokeAdminUserSessions(user.id);
      setNotice(result.revokedCount ? `已终止 ${result.revokedCount} 个登录会话` : "这个账号没有活跃登录会话");
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      throw cause;
    } finally {
      setSaving(false);
    }
  };

  return <section className="workspace users-workspace">
    <PageHeader eyebrow="账号与权限 / DIRECTORY" title="用户管理" actions={<button className="refresh-button" type="button" onClick={() => void refresh()} disabled={loading || saving}><Icon name="refresh" size={14} /><span>{loading ? "读取中" : "刷新目录"}</span></button>} />
    {error && <p className="notice error">{error}</p>}
    {notice && <p className="notice success"><Icon name="check" size={14} />{notice}</p>}
    <MetricStrip label="用户摘要" items={[
      { label: "全部账号", value: String(users.length), detail: `${active} 个正常`, tone: "accent", icon: "users" },
      { label: "管理员", value: String(admins), detail: "Full / OCI", tone: "success", icon: "shield" },
      { label: "待验证", value: String(pending), detail: "尚未完成邮箱验证", tone: "warning", icon: "pulse" },
      { label: "工作区", value: String(resources), detail: "用户资源总数", icon: "workspace" },
    ]} />
    <div className="user-directory-toolbar"><div><span className="toolbar-kicker">ACCOUNT DIRECTORY</span><strong>账号目录</strong><span>搜索、筛选并编辑权限</span></div><span className="toolbar-selection">{selected ? `当前编辑：${selected.displayName}` : "未选择账号"}</span></div>
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索姓名或邮箱" selected={filter} onSelect={(value) => setFilter(value as UserFilter)} resultCount={visible.length} options={[
      { id: "all", label: "全部" }, { id: "active", label: "正常" },
      { id: "pending", label: "待验证" }, { id: "disabled", label: "已停用" },
    ]} />
    <div className="user-management-grid">
      <UsersTable users={visible} loading={loading} selectedId={selectedId} onEdit={(user) => { setSelectedId(user.id); setNotice(""); }} />
      {selected && <button className="editor-backdrop" type="button" aria-label="关闭编辑面板" onClick={() => setSelectedId("")} />}
      <UserEditor user={selected} onClose={() => setSelectedId("")} onSave={saveUser} onRevoke={revokeUserSessions} onError={setError} />
    </div>
  </section>;
}
