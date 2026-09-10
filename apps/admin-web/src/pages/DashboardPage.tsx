import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  fetchAdminSessions,
  fetchAdminSummary,
  fetchAdminUsers,
  fetchBillingSummary,
  fetchDashboard,
  type AdminDashboardSnapshot,
  type AdminSessionSummary,
  type AdminSummary,
  type AdminUserSummary,
  type BillingAggregate,
} from "../api.js";
import { MetricStrip, PageHeader, type MetricItem } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";
import { isActiveSession, sessionActivityPoints } from "../admin-view-model.js";

interface HomeData {
  summary: AdminSummary | null;
  runtime: AdminDashboardSnapshot | null;
  billing: BillingAggregate[] | null;
  users: AdminUserSummary[] | null;
  sessions: AdminSessionSummary[] | null;
}

interface HomeErrors {
  summary?: string;
  runtime?: string;
  billing?: string;
  users?: string;
  sessions?: string;
}

const EMPTY_DATA: HomeData = { summary: null, runtime: null, billing: null, users: null, sessions: null };

function count(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function date(value: string | undefined): string {
  if (!value) return "暂无记录";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "暂无记录" : parsed.toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "CONTROL_PLANE_DISABLED") return "运行观察未启用";
  if (error.code === "WORKER_UNAVAILABLE") return "Worker 不可用";
  if (error.code === "WORKER_INVALID_RESPONSE") return "Worker 返回无效数据";
  return error.code;
}

function modelCostPoints(rows: BillingAggregate[]): Array<{ label: string; value: number; calls: number }> {
  const grouped = new Map<string, { value: number; calls: number }>();
  for (const row of rows) {
    const current = grouped.get(row.model) ?? { value: 0, calls: 0 };
    grouped.set(row.model, { value: current.value + row.totalUsd, calls: current.calls + row.calls });
  }
  return [...grouped.entries()]
    .map(([label, values]) => ({ label, ...values }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
}

function Panel(props: { title: string; meta?: string; children: React.ReactNode; className?: string }) {
  return <section className={`dashboard-panel ${props.className ?? ""}`}><header className="dashboard-panel-heading"><h3>{props.title}</h3>{props.meta && <span>{props.meta}</span>}</header>{props.children}</section>;
}

function overviewItems(data: HomeData): MetricItem[] {
  const summary = data.summary;
  const billingTotal = data.billing?.reduce((total, row) => total + row.totalUsd, 0);
  const billingDetail = data.billing ? `${count(data.billing.reduce((total, row) => total + row.calls, 0))} 次调用` : "等待计费数据";
  return [
    { label: "活跃用户", value: summary ? count(summary.users.active) : "—", detail: summary ? `共 ${count(summary.users.total)} 个账号` : "等待用户数据", tone: "accent", icon: "users" },
    { label: "在线会话", value: summary ? count(summary.sessions.active) : "—", detail: summary ? `共 ${count(summary.sessions.total)} 个登录会话` : "等待会话数据", tone: "success", icon: "pulse" },
    { label: "工作区", value: summary ? count(summary.resources.workspaces) : "—", detail: summary ? `${count(summary.resources.identities)} 个已绑定身份` : "等待资源数据", icon: "workspace" },
    { label: "本月用量", value: billingTotal === undefined ? "—" : money(billingTotal), detail: billingDetail, tone: "warning", icon: "billing" },
  ];
}

function HealthPanel({ data, errors }: { data: HomeData; errors: HomeErrors }) {
  const runtime = data.runtime;
  const targets = runtime?.targets ?? [];
  const readyTargets = targets.filter((target) => target.session.exists).length;
  const runtimeState = runtime ? "online" : errors.runtime ? "offline" : "pending";
  const stateLabel = runtimeState === "online" ? "运行中" : runtimeState === "offline" ? "异常" : "检查中";
  return <Panel title="系统健康" meta={runtime ? `读取于 ${date(runtime.worker.observedAt)}` : "实时检查"} className="health-panel">
    <div className="health-status"><span className={`status-dot ${runtimeState}`} /><strong>{stateLabel}</strong><span>{runtime ? "Worker 控制面已连接" : errors.runtime ?? "正在读取 Worker 状态"}</span></div>
    <div className="health-list">
      <div><span>队列深度</span><strong>{runtime ? count(runtime.worker.queueDepth) : "—"}</strong></div>
      <div><span>目标覆盖</span><strong>{runtime ? `${readyTargets}/${targets.length}` : "—"}</strong></div>
      <div><span>目标配置</span><strong>{runtime ? count(targets.length) : "—"}</strong></div>
    </div>
    {errors.runtime && <p className="panel-alert">{errors.runtime}</p>}
  </Panel>;
}

function UsagePanel({ rows, error }: { rows: BillingAggregate[] | null; error?: string }) {
  if (!rows) return <Panel title="用量分布" meta="模型计费"><div className="panel-state">{error ?? "正在读取用量"}</div></Panel>;
  const input = rows.reduce((total, row) => total + row.inputTokens, 0);
  const output = rows.reduce((total, row) => total + row.outputTokens, 0);
  const reasoning = rows.reduce((total, row) => total + row.reasoningTokens, 0);
  const max = Math.max(input, output, reasoning, 1);
  const totalCalls = rows.reduce((total, row) => total + row.calls, 0);
  return <Panel title="用量分布" meta={`${count(totalCalls)} 次调用`} className="usage-panel">
    <div className="usage-bars">
      <div className="usage-bar-row"><span>输入 token</span><div className="usage-bar"><i style={{ width: `${(input / max) * 100}%` }} /></div><strong>{count(input)}</strong></div>
      <div className="usage-bar-row"><span>输出 token</span><div className="usage-bar output"><i style={{ width: `${(output / max) * 100}%` }} /></div><strong>{count(output)}</strong></div>
      <div className="usage-bar-row"><span>推理 token</span><div className="usage-bar reasoning"><i style={{ width: `${(reasoning / max) * 100}%` }} /></div><strong>{count(reasoning)}</strong></div>
    </div>
    <div className="usage-foot"><span>{rows.length} 个模型计费分组</span><a href="/admin/billing">查看明细</a></div>
  </Panel>;
}

function UserMixPanel({ users, error }: { users: AdminUserSummary[] | null; error?: string }) {
  if (!users) return <Panel title="用户构成" meta="账号状态"><div className="panel-state">{error ?? "正在读取用户数据"}</div></Panel>;
  const groups = [
    { label: "正常账号", value: users.filter((user) => user.status === "active").length, tone: "success" },
    { label: "待验证", value: users.filter((user) => user.status === "pending").length, tone: "warning" },
    { label: "已停用", value: users.filter((user) => user.status === "disabled").length, tone: "muted" },
  ] as const;
  const total = Math.max(users.length, 1);
  return <Panel title="用户构成" meta={`${users.length} 个账号`} className="user-mix-panel">
    <div className="mix-total"><strong>{count(users.length)}</strong><span>注册账号</span><small>{count(users.filter((user) => user.role === "admin").length)} 个管理员</small></div>
    <div className="mix-bars">{groups.map((group) => <div className="mix-row" key={group.label}><div><span>{group.label}</span><strong>{group.value}</strong></div><div className="mix-track"><i className={group.tone} style={{ width: `${(group.value / total) * 100}%` }} /></div></div>)}</div>
    <a className="panel-link" href="/admin/users">管理账号 <Icon name="arrow-right" size={14} /></a>
  </Panel>;
}

function ModelCostChart({ rows, error }: { rows: BillingAggregate[] | null; error?: string }) {
  const points = useMemo(() => modelCostPoints(rows ?? []), [rows]);
  if (!rows) return <Panel title="模型费用" meta="USD"><div className="panel-state">{error ?? "正在读取费用数据"}</div></Panel>;
  if (!points.length) return <Panel title="模型费用" meta="USD"><div className="panel-state">暂无模型费用记录</div></Panel>;
  const max = Math.max(...points.map((point) => point.value), 0.000001);
  return <Panel title="模型费用" meta={`${points.length} 个模型`} className="chart-panel">
    <div className="chart-bars" role="img" aria-label="按模型汇总的费用柱状图">{points.map((point) => <div className="chart-column" key={point.label}><div className="chart-bar-track"><i style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }} title={`${point.label} ${money(point.value)}`} /></div><strong>{money(point.value)}</strong><span title={point.label}>{point.label}</span></div>)}</div>
    <div className="chart-foot"><span>合计 {money(points.reduce((total, point) => total + point.value, 0))}</span><span>{count(points.reduce((total, point) => total + point.calls, 0))} 次调用</span></div>
  </Panel>;
}

function LoginActivityChart({ sessions, error }: { sessions: AdminSessionSummary[] | null; error?: string }) {
  const points = useMemo(() => sessionActivityPoints(sessions ?? []), [sessions]);
  if (!sessions) return <Panel title="登录活动" meta="近 7 日"><div className="panel-state">{error ?? "正在读取登录活动"}</div></Panel>;
  if (!points.length) return <Panel title="登录活动" meta="近 7 日"><div className="panel-state">暂无可用登录记录</div></Panel>;
  const max = Math.max(...points.map((point) => point.value), 1);
  const coordinates = points.map((point, index) => ({ x: 12 + index * 49.33, y: 112 - (point.value / max) * 82 }));
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  return <Panel title="登录活动" meta="按会话创建日" className="chart-panel"><div className="line-chart"><svg viewBox="0 0 320 136" role="img" aria-label="近七日登录活动曲线图"><g className="chart-grid-lines"><line x1="12" y1="30" x2="308" y2="30" /><line x1="12" y1="71" x2="308" y2="71" /><line x1="12" y1="112" x2="308" y2="112" /></g><polyline className="chart-area" points={`${line} 308,112 12,112`} /><polyline className="chart-line" points={line} />{coordinates.map((point) => <circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r="3" />)}</svg><div className="chart-x-labels">{points.map((point) => <span key={point.key}>{point.label}</span>)}</div></div><div className="chart-foot"><span>峰值 {count(max)} 个会话</span><span>合计 {count(points.reduce((total, point) => total + point.value, 0))}</span></div></Panel>;
}

function RuntimePanel({ runtime, error }: { runtime: AdminDashboardSnapshot | null; error?: string }) {
  if (!runtime) return <Panel title="运行观察" meta="会话投影"><div className="panel-state"><strong>运行观察不可用</strong><span>{error ?? "正在读取会话目标"}</span><a href="/admin/conversations">打开运行观察</a></div></Panel>;
  return <Panel title="运行观察" meta={`${runtime.targets.length} 个目标`} className="runtime-panel">
    <div className="runtime-list">{runtime.targets.slice(0, 4).map((item) => <a className="runtime-row" href="/admin/conversations" key={item.target.id}><span className={`status-dot ${item.session.exists ? "online" : "idle"}`} /><span className="runtime-name"><strong>{item.target.label}</strong><small>代次 {item.generation}</small></span><span className="runtime-state">{item.session.exists ? "有活动" : "空闲"}</span><span className="runtime-arrow" aria-hidden="true"><Icon name="arrow-right" size={14} /></span></a>)}</div>
    {!runtime.targets.length && <div className="panel-state">暂无配置目标</div>}
    <a className="panel-link" href="/admin/conversations">进入运行观察 <Icon name="arrow-right" size={14} /></a>
  </Panel>;
}

function RecentSessionsPanel({ sessions, error }: { sessions: AdminSessionSummary[] | null; error?: string }) {
  const recent = useMemo(() => [...(sessions ?? [])].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 5), [sessions]);
  if (!sessions) return <Panel title="最近登录" meta="账号活动"><div className="panel-state">{error ?? "正在读取登录活动"}</div></Panel>;
  return <Panel title="最近登录" meta={`${sessions.filter((item) => isActiveSession(item)).length} 个在线`} className="sessions-panel">
    <div className="recent-list">{recent.map((session) => <div className="recent-row" key={session.id}><span className="avatar small">{session.displayName.slice(0, 1)}</span><span className="recent-name"><strong>{session.displayName}</strong><small>{session.email}</small></span><span className={`badge ${isActiveSession(session) ? "active" : "revoked"}`}>{isActiveSession(session) ? "在线" : "离线"}</span><time>{date(session.lastSeenAt)}</time></div>)}</div>
    {!recent.length && <div className="panel-state">暂无登录活动</div>}
    <a className="panel-link" href="/admin/sessions">查看全部会话 <Icon name="arrow-right" size={14} /></a>
  </Panel>;
}

function AlertsPanel({ errors }: { errors: HomeErrors }) {
  const alerts = Object.entries(errors).map(([key, value]) => ({ key, value })).filter((item): item is { key: string; value: string } => Boolean(item.value));
  return <Panel title="告警与数据状态" meta={alerts.length ? `${alerts.length} 项待处理` : "当前正常"} className={alerts.length ? "alerts-panel has-alerts" : "alerts-panel"}>
    {alerts.length ? <ul className="alert-list">{alerts.map((alert) => <li key={alert.key}><span className="status-dot offline" /><span>{alert.value}</span></li>)}</ul> : <div className="panel-state success-state"><span className="status-dot online" /><strong>所有看板数据已同步</strong></div>}
  </Panel>;
}

function QuickLinks() {
  return <Panel title="快捷入口" meta="管理操作" className="quick-panel"><div className="quick-links"><a href="/admin/users"><span className="quick-icon"><Icon name="users" size={16} /></span><span><strong>用户管理</strong><small>账号与默认模式</small></span><b><Icon name="arrow-right" size={14} /></b></a><a href="/admin/billing"><span className="quick-icon"><Icon name="billing" size={16} /></span><span><strong>用量与额度</strong><small>模型价格和预算</small></span><b><Icon name="arrow-right" size={14} /></b></a><a href="/admin/knowledge"><span className="quick-icon"><Icon name="knowledge" size={16} /></span><span><strong>知识库</strong><small>文档与摄入任务</small></span><b><Icon name="arrow-right" size={14} /></b></a></div></Panel>;
}

export function DashboardPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<HomeData>(EMPTY_DATA);
  const [errors, setErrors] = useState<HomeErrors>({});
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([fetchAdminSummary(), fetchDashboard(), fetchBillingSummary(), fetchAdminUsers(), fetchAdminSessions()]);
    if (results.some((result) => result.status === "rejected" && result.reason instanceof ApiError && result.reason.status === 401)) {
      onUnauthorized();
      setLoading(false);
      return;
    }
    const [summary, runtime, billing, users, sessions] = results;
    const nextErrors: HomeErrors = {};
    if (summary.status === "rejected") nextErrors.summary = errorMessage(summary.reason, "用户摘要不可用");
    if (runtime.status === "rejected") nextErrors.runtime = errorMessage(runtime.reason, "运行观察不可用");
    if (billing.status === "rejected") nextErrors.billing = errorMessage(billing.reason, "用量数据不可用");
    if (users.status === "rejected") nextErrors.users = errorMessage(users.reason, "用户数据不可用");
    if (sessions.status === "rejected") nextErrors.sessions = errorMessage(sessions.reason, "会话数据不可用");
    setData((current) => ({
      summary: summary.status === "fulfilled" ? summary.value : current.summary,
      runtime: runtime.status === "fulfilled" ? runtime.value : current.runtime,
      billing: billing.status === "fulfilled" ? billing.value.rows : current.billing,
      users: users.status === "fulfilled" ? users.value.users : current.users,
      sessions: sessions.status === "fulfilled" ? sessions.value.sessions : current.sessions,
    }));
    setErrors(nextErrors);
    setLoading(false);
  }, [onUnauthorized]);

  useEffect(() => { void refresh(); }, [refresh]);

  const lastUpdated = data.runtime?.worker.observedAt ?? data.summary?.observedAt;
  return <section className="workspace dashboard-workspace">
    <PageHeader eyebrow="管理员工作台 / LIVE" title="运营总览" status={<span className={`sync-state ${data.runtime ? "online" : "offline"}`}><i />{data.runtime ? "实时同步" : "等待同步"}</span>} actions={<button className="refresh-button" type="button" onClick={() => void refresh()} disabled={loading}><Icon name="refresh" size={14} /><span>{loading ? "读取中" : "刷新数据"}</span></button>} />
    {Object.keys(errors).length > 0 && <p className="notice stale">部分数据暂不可用，已保留最近一次成功读取的结果。</p>}
    <MetricStrip label="核心指标" items={overviewItems(data)} />
    <section className="dashboard-grid dashboard-grid-primary dashboard-grid-triple"><HealthPanel data={data} errors={errors} /><UsagePanel rows={data.billing} error={errors.billing} /><UserMixPanel users={data.users} error={errors.users} /></section>
    <section className="dashboard-grid dashboard-grid-charts"><ModelCostChart rows={data.billing} error={errors.billing} /><LoginActivityChart sessions={data.sessions} error={errors.sessions} /></section>
    <section className="dashboard-grid"><RuntimePanel runtime={data.runtime} error={errors.runtime} /><RecentSessionsPanel sessions={data.sessions} error={errors.sessions} /></section>
    <section className="dashboard-grid dashboard-grid-secondary"><AlertsPanel errors={errors} /><QuickLinks /></section>
    {lastUpdated && <p className="dashboard-updated">数据更新时间 {date(lastUpdated)}</p>}
  </section>;
}
