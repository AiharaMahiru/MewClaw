import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  fetchAdminIdentities,
  fetchAdminUsers,
  revokeAdminUserSessions,
  unlinkAdminIdentity,
  updateAdminUser,
  type AdminIdentity,
  type AdminMode,
  type AdminRole,
  type AdminUserSummary,
} from "../api.js";
import { Badge, Card, FilterBar, MetricStrip, PageHeader, RefreshButton, Select } from "../components/AdminUi.js";
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

function statusTone(status: AdminUserSummary["status"]): "ok" | "warn" | "err" | undefined {
  return status === "active" ? "ok" : status === "pending" ? "warn" : "err";
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
  if (cause.code === "IDENTITY_LAST_LOGIN_METHOD") return "这是该账号最后的登录方式，无法解绑";
  if (cause.code === "IDENTITY_NOT_FOUND") return "身份绑定已不存在，请刷新列表";
  if (cause.code === "ADMIN_REQUIRED") return "需要管理员权限";
  return cause.code;
}

function IdentitySection(props: { user: AdminUserSummary; onError: (message: string) => void; onChanged: () => void }) {
  const [identities, setIdentities] = useState<AdminIdentity[] | null>(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchAdminIdentities();
      setIdentities(result.identities.filter((identity) => identity.user.id === props.user.id));
    } catch (cause) {
      props.onError(actionError(cause));
      setIdentities([]);
    }
  }, [props.user.id, props.onError]);

  useEffect(() => { void load(); }, [load]);

  const unlink = async (identity: AdminIdentity): Promise<void> => {
    if (busy || !window.confirm(`解绑飞书身份 ${identity.subject}？`)) return;
    setBusy(identity.subject);
    props.onError("");
    try {
      await unlinkAdminIdentity(props.user.id, identity.subject);
      await load();
      props.onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) throw cause;
      props.onError(actionError(cause));
    } finally {
      setBusy("");
    }
  };

  return <div className="adm-section"><div className="adm-section-head"><span>身份绑定</span><small>飞书登录凭据</small></div>
    {identities === null && <div className="adm-state"><span className="adm-spinner" /><span>正在读取身份绑定…</span></div>}
    {identities !== null && !identities.length && <div className="adm-state"><span>没有绑定的外部身份</span></div>}
    {identities !== null && identities.map((identity) => <div className="adm-identity" key={identity.subject}>
      <Badge tone="info">飞书</Badge>
      <span className="adm-identity-main"><code>{identity.subject}</code>{identity.unionId && <span className="adm-sub">union {identity.unionId}</span>}<span className="adm-sub">绑定于 {date(identity.createdAt)}</span></span>
      <button className="adm-btn adm-btn-sm" type="button" disabled={Boolean(busy)} onClick={() => void unlink(identity)}>{busy === identity.subject ? "解绑中" : "解绑"}</button>
    </div>)}
  </div>;
}

function UserDrawer(props: {
  user: AdminUserSummary;
  onClose: () => void;
  onSave: (user: AdminUserSummary, patch: UserPatch) => Promise<void>;
  onRevoke: (user: AdminUserSummary) => Promise<void>;
  onIdentitiesChanged: () => void;
  onError: (message: string) => void;
}) {
  const user = props.user;
  const [role, setRole] = useState<AdminRole>(user.role);
  const [status, setStatus] = useState<"active" | "disabled">(user.status === "disabled" ? "disabled" : "active");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRole(user.role);
    setStatus(user.status === "disabled" ? "disabled" : "active");
  }, [user]);

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

  return <>
    <button className="adm-backdrop" type="button" aria-label="关闭编辑面板" onClick={props.onClose} />
    <aside className="adm-drawer" aria-label="编辑用户">
      <div className="adm-drawer-head"><div><span className="adm-drawer-kicker">ACCOUNT</span><h2 className="adm-drawer-title">账号设置</h2></div><button className="adm-iconbtn" type="button" aria-label="关闭" title="关闭" onClick={props.onClose}><Icon name="close" size={16} /></button></div>
      <div className="adm-drawer-body">
        <div className="adm-profile">
          <span className="adm-avatar adm-avatar-lg" aria-hidden="true">{user.displayName.slice(0, 1)}</span>
          <div className="adm-profile-main"><strong>{user.displayName}</strong><span>{user.email}</span><div className="adm-profile-badges"><Badge tone={user.role === "admin" ? "info" : undefined}>{user.role === "admin" ? "管理员" : "成员"}</Badge><Badge tone={statusTone(user.status)}>{statusLabel(user.status)}</Badge></div></div>
        </div>
        <form className="adm-drawer-body" style={{ padding: 0 }} onSubmit={(event) => void submit(event)}>
          <div className="adm-section"><div className="adm-section-head"><span>身份与权限</span><small>仅管理员可修改</small></div>
            <div className="adm-field"><span className="adm-label">邮箱地址</span><div className="adm-readonly">{user.email}<Icon name="shield" size={13} /></div></div>
            <div className="adm-field"><span className="adm-label">角色</span><div className="adm-choices">
              <button className={`adm-choice ${role === "user" ? "is-on" : ""}`} type="button" disabled={user.status === "pending" || saving} onClick={() => setRole("user")}><Icon name="users" size={15} /><span className="adm-choice-main"><strong>成员</strong><small>轻量工作区</small></span>{role === "user" && <Icon name="check" size={14} />}</button>
              <button className={`adm-choice ${role === "admin" ? "is-on" : ""}`} type="button" disabled={user.status === "pending" || saving} onClick={() => setRole("admin")}><Icon name="shield" size={15} /><span className="adm-choice-main"><strong>管理员</strong><small>Full / OCI</small></span>{role === "admin" && <Icon name="check" size={14} />}</button>
            </div></div>
          </div>
          <div className="adm-section"><div className="adm-section-head"><span>访问状态</span><small>会话即时生效</small></div>
            {user.status === "pending" ? <div className="adm-state"><span>待完成邮箱验证，暂不可编辑状态</span></div> : <label className="adm-field"><span className="adm-label">账号状态</span><Select value={status} disabled={saving} onChange={(value) => setStatus(value as "active" | "disabled")} options={[{ value: "active", label: "正常 · 允许登录" }, { value: "disabled", label: "已停用 · 拒绝登录" }]} /></label>}
            <div className="adm-field"><span className="adm-label">默认运行模式</span><div className="adm-readonly">{modeLabel(effectiveMode)}<span className="adm-sub">由角色自动决定</span></div></div>
          </div>
          <div className="adm-section"><div className="adm-section-head"><span>资源概览</span><small>只读</small></div>
            <div className="adm-statgrid"><div><strong>{user.sessionCount}</strong><span>登录会话</span></div><div><strong>{user.workspaceCount}</strong><span>工作区</span></div><div><strong>{user.identityCount}</strong><span>身份绑定</span></div></div>
          </div>
          <IdentitySection user={user} onError={props.onError} onChanged={props.onIdentitiesChanged} />
          <div className="adm-actions"><button className="adm-btn adm-btn-primary" type="submit" disabled={!changed || saving}><Icon name="check" size={14} /><span>{saving ? "保存中" : "保存修改"}</span></button><button className="adm-btn" type="button" onClick={props.onClose} disabled={saving}>取消</button></div>
        </form>
      </div>
      <div className="adm-drawer-danger"><button className="adm-btn adm-btn-danger" type="button" disabled={!user.sessionCount || saving} onClick={() => void revoke()}><Icon name="sessions" size={14} /><span>{user.sessionCount ? `终止 ${user.sessionCount} 个登录会话` : "暂无活跃会话"}</span></button></div>
      <div className="adm-drawer-foot">创建于 {date(user.createdAt)} · 最近更新 {date(user.updatedAt)}</div>
    </aside>
  </>;
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
      setSelectedId((current) => current && next.some((user) => user.id === current) ? current : "");
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

  return <>
    <PageHeader title="用户管理" sub="账号目录与权限" actions={<RefreshButton busy={loading || saving} label="刷新目录" onClick={() => void refresh()} />} />
    {error && <p className="adm-notice adm-notice-err">{error}</p>}
    {notice && <p className="adm-notice adm-notice-ok"><Icon name="check" size={14} />{notice}</p>}
    <MetricStrip label="用户摘要" items={[
      { label: "全部账号", value: String(users.length), detail: `${active} 个正常`, tone: "accent", icon: "users" },
      { label: "管理员", value: String(admins), detail: "Full / OCI", tone: "success", icon: "shield" },
      { label: "待验证", value: String(pending), detail: "尚未完成邮箱验证", tone: "warning", icon: "pulse" },
      { label: "工作区", value: String(resources), detail: "用户资源总数", icon: "workspace" },
    ]} />
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索姓名或邮箱" selected={filter} onSelect={(value) => setFilter(value as UserFilter)} resultCount={visible.length} options={[
      { id: "all", label: "全部" }, { id: "active", label: "正常" },
      { id: "pending", label: "待验证" }, { id: "disabled", label: "已停用" },
    ]} />
    <Card title="账号目录" meta={`${visible.length} 个结果`}>
      <div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>默认模式</th><th>资源</th><th>创建时间</th><th aria-label="编辑" /></tr></thead>
        <tbody>{visible.map((user) => <tr className={user.id === selectedId ? "is-selected" : ""} key={user.id} onDoubleClick={() => setSelectedId(user.id)}>
          <td><span className="adm-row" style={{ border: 0, padding: 0 }}><span className="adm-avatar adm-avatar-sm">{user.displayName.slice(0, 1)}</span><span className="adm-row-main"><strong>{user.displayName}</strong><small>{user.email}</small></span></span></td>
          <td><Badge tone={user.role === "admin" ? "info" : undefined}>{user.role === "admin" ? "管理员" : "成员"}</Badge></td>
          <td><Badge tone={statusTone(user.status)}>{statusLabel(user.status)}</Badge></td>
          <td>{modeLabel(user.defaultMode)}</td>
          <td><strong>{user.sessionCount} 会话</strong><span className="adm-sub">{user.workspaceCount} 工作区 · {user.identityCount} 身份</span></td>
          <td>{date(user.createdAt)}</td>
          <td><button className="adm-btn adm-btn-sm" type="button" aria-label={`编辑 ${user.displayName}`} onClick={() => { setSelectedId(user.id); setNotice(""); }}><Icon name="edit" size={13} /><span>编辑</span></button></td>
        </tr>)}{!visible.length && !loading && <tr><td className="adm-empty" colSpan={7}>没有符合条件的用户</td></tr>}{loading && <tr><td className="adm-empty" colSpan={7}><span className="adm-spinner" /> 正在读取账号目录</td></tr>}</tbody>
      </table></div>
    </Card>
    {selected && <UserDrawer user={selected} onClose={() => setSelectedId("")} onSave={saveUser} onRevoke={revokeUserSessions} onIdentitiesChanged={() => void refresh()} onError={setError} />}
  </>;
}
