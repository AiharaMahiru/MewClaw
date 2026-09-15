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
import { Badge, Card, Dot, Empty, MetricStrip, PageHeader, RefreshButton, Skeleton, type MetricItem } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";
import { isActiveSession, sessionActivityPoints } from "../admin-view-model.js";

interface HomeData {
  summary: AdminSummary | null;
  runtime: AdminDashboardSnapshot | null;
  billing: BillingAggregate[] | null;
  users: AdminUserSummary[] | null;
  sessions: AdminSessionSummary[] | null;
}

type HomeErrors = Partial<Record<keyof HomeData, string>>;

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
  return [...grouped.entries()].map(([label, values]) => ({ label, ...values })).sort((a, b) => b.value - a.value).slice(0, 6);
}

function overviewItems(data: HomeData): MetricItem[] {
  const summary = data.summary;
  const billingTotal = data.billing?.reduce((total, row) => total + row.totalUsd, 0);
  return [
    { label: "活跃用户", value: summary ? count(summary.users.active) : "—", detail: summary ? `共 ${count(summary.users.total)} 个账号` : "等待用户数据", tone: "accent", icon: "users" },
    { label: "在线会话", value: summary ? count(summary.sessions.active) : "—", detail: summary ? `共 ${count(summary.sessions.total)} 个登录会话` : "等待会话数据", tone: "success", icon: "pulse" },
    { label: "工作区", value: summary ? count(summary.resources.workspaces) : "—", detail: summary ? `${count(summary.resources.identities)} 个已绑定身份` : "等待资源数据", icon: "workspace" },
    { label: "本月用量", value: billingTotal === undefined ? "—" : money(billingTotal), detail: data.billing ? `${count(data.billing.reduce((total, row) => total + row.calls, 0))} 次调用` : "等待计费数据", tone: "warning", icon: "billing" },
  ];
}

function HealthPanel({ data, errors }: { data: HomeData; errors: HomeErrors }) {
  const runtime = data.runtime;
  const targets = runtime?.targets ?? [];
  const readyTargets = targets.filter((target) => target.session.exists).length;
  return <Card title="系统健康" meta={runtime ? `读取于 ${date(runtime.worker.observedAt)}` : "实时检查"}>
    <div className="adm-health"><Dot tone={runtime ? "ok" : errors.runtime ? "err" : "warn"} /><strong>{runtime ? "运行中" : errors.runtime ? "异常" : "检查中"}</strong><span>{runtime ? "Worker 控制面已连接" : errors.runtime ?? "正在读取 Worker 状态"}</span></div>
    <div className="adm-statgrid" style={{ marginTop: 14 }}><div><strong>{runtime ? count(runtime.worker.queueDepth) : "—"}</strong><span>队列深度</span></div><div><strong>{runtime ? `${readyTargets}/${targets.length}` : "—"}</strong><span>目标覆盖</span></div><div><strong>{runtime ? count(targets.length) : "—"}</strong><span>目标配置</span></div></div>
    {errors.runtime && <p className="adm-notice adm-notice-warn" style={{ marginTop: 12 }}>{errors.runtime}</p>}
  </Card>;
}

function UsagePanel({ rows, error }: { rows: BillingAggregate[] | null; error?: string }) {
  if (!rows) return <Card title="用量分布" meta="模型计费">{error ? <Empty>{error}</Empty> : <Skeleton />}</Card>;
  const input = rows.reduce((total, row) => total + row.inputTokens, 0);
  const output = rows.reduce((total, row) => total + row.outputTokens, 0);
  const reasoning = rows.reduce((total, row) => total + row.reasoningTokens, 0);
  const max = Math.max(input, output, reasoning, 1);
  const totalCalls = rows.reduce((total, row) => total + row.calls, 0);
  return <Card title="用量分布" meta={`${count(totalCalls)} 次调用`}>
    <div className="adm-bars">
      <div className="adm-bar-row"><span>输入 token</span><div className="adm-bar"><i style={{ width: `${(input / max) * 100}%` }} /></div><strong>{count(input)}</strong></div>
      <div className="adm-bar-row"><span>输出 token</span><div className="adm-bar adm-bar-ok"><i style={{ width: `${(output / max) * 100}%` }} /></div><strong>{count(output)}</strong></div>
      <div className="adm-bar-row"><span>推理 token</span><div className="adm-bar adm-bar-warn"><i style={{ width: `${(reasoning / max) * 100}%` }} /></div><strong>{count(reasoning)}</strong></div>
    </div>
    <div className="adm-foot"><span>{rows.length} 个模型计费分组</span><a href="/admin/billing">查看明细</a></div>
  </Card>;
}

function UserMixPanel({ users, error }: { users: AdminUserSummary[] | null; error?: string }) {
  if (!users) return <Card title="用户构成" meta="账号状态">{error ? <Empty>{error}</Empty> : <Skeleton />}</Card>;
  const groups = [
    { label: "正常账号", value: users.filter((user) => user.status === "active").length, tone: "" },
    { label: "待验证", value: users.filter((user) => user.status === "pending").length, tone: "adm-bar-warn" },
    { label: "已停用", value: users.filter((user) => user.status === "disabled").length, tone: "adm-bar" },
  ];
  const total = Math.max(users.length, 1);
  return <Card title="用户构成" meta={`${users.length} 个账号`}>
    <div className="adm-mix"><strong>{count(users.length)}</strong><span>注册账号</span><small>{count(users.filter((user) => user.role === "admin").length)} 个管理员</small></div>
    <div className="adm-bars">{groups.map((group) => <div className="adm-bar-row" key={group.label}><span>{group.label}</span><div className={`adm-bar ${group.tone}`}><i style={{ width: `${(group.value / total) * 100}%` }} /></div><strong>{group.value}</strong></div>)}</div>
    <a className="adm-card-link" href="/admin/users">管理账号 <Icon name="arrow-right" size={13} /></a>
  </Card>;
}

function ModelCostChart({ rows, error }: { rows: BillingAggregate[] | null; error?: string }) {
  const points = useMemo(() => modelCostPoints(rows ?? []), [rows]);
  if (!rows || !points.length) return <Card title="模型费用" meta="USD">{error ? <Empty>{error}</Empty> : rows ? <Empty>暂无模型费用记录</Empty> : <Skeleton />}</Card>;
  const max = Math.max(...points.map((point) => point.value), 0.000001);
  return <Card title="模型费用" meta={`${points.length} 个模型`}>
    <div className="adm-chart-bars" role="img" aria-label="按模型汇总的费用柱状图">{points.map((point) => <div className="adm-chart-col" key={point.label}><div className="adm-chart-track"><i style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }} title={`${point.label} ${money(point.value)}`} /></div><strong>{money(point.value)}</strong><span title={point.label}>{point.label}</span></div>)}</div>
    <div className="adm-foot"><span>合计 {money(points.reduce((total, point) => total + point.value, 0))}</span><span>{count(points.reduce((total, point) => total + point.calls, 0))} 次调用</span></div>
  </Card>;
}

function LoginActivityChart({ sessions, error }: { sessions: AdminSessionSummary[] | null; error?: string }) {
  const points = useMemo(() => sessionActivityPoints(sessions ?? []), [sessions]);
  if (!sessions || !points.length) return <Card title="登录活动" meta="近 7 日">{error ? <Empty>{error}</Empty> : sessions ? <Empty>暂无可用登录记录</Empty> : <Skeleton />}</Card>;
  const max = Math.max(...points.map((point) => point.value), 1);
  const coordinates = points.map((point, index) => ({ x: 12 + index * 49.33, y: 112 - (point.value / max) * 82 }));
  const line = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  return <Card title="登录活动" meta="按会话创建日">
    <div className="adm-chart-line"><svg viewBox="0 0 320 136" role="img" aria-label="近七日登录活动曲线图"><g><line x1="12" y1="30" x2="308" y2="30" /><line x1="12" y1="71" x2="308" y2="71" /><line x1="12" y1="112" x2="308" y2="112" /></g><polyline className="adm-chart-area" points={`${line} 308,112 12,112`} /><polyline className="adm-chart-stroke" points={line} />{coordinates.map((point) => <circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r="3" />)}</svg><div className="adm-chart-x">{points.map((point) => <span key={point.key}>{point.label}</span>)}</div></div>
    <div className="adm-foot"><span>峰值 {count(max)} 个会话</span><span>合计 {count(points.reduce((total, point) => total + point.value, 0))}</span></div>
  </Card>;
}

function RuntimePanel({ runtime, error }: { runtime: AdminDashboardSnapshot | null; error?: string }) {
  if (!runtime) return <Card title="运行观察" meta="会话投影">{error ? <Empty><strong>运行观察不可用</strong><span>{error}</span><a href="/admin/conversations">打开运行观察</a></Empty> : <Skeleton />}</Card>;
  return <Card title="运行观察" meta={`${runtime.targets.length} 个目标`}>
    <div className="adm-rows">{runtime.targets.slice(0, 4).map((item) => <a className="adm-row" href="/admin/conversations" key={item.target.id}><Dot tone={item.session.exists ? "ok" : "warn"} /><span className="adm-row-main"><strong>{item.target.label}</strong><small>代次 {item.generation}</small></span><span className="adm-row-side">{item.session.exists ? "有活动" : "空闲"}</span><Icon name="arrow-right" size={13} /></a>)}</div>
    {!runtime.targets.length && <Empty>暂无配置目标</Empty>}
    <a className="adm-card-link" href="/admin/conversations">进入运行观察 <Icon name="arrow-right" size={13} /></a>
  </Card>;
}

function RecentSessionsPanel({ sessions, error }: { sessions: AdminSessionSummary[] | null; error?: string }) {
  const recent = useMemo(() => [...(sessions ?? [])].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)).slice(0, 5), [sessions]);
  if (!sessions) return <Card title="最近登录" meta="账号活动">{error ? <Empty>{error}</Empty> : <Skeleton />}</Card>;
  return <Card title="最近登录" meta={`${sessions.filter((item) => isActiveSession(item)).length} 个在线`}>
    <div className="adm-rows">{recent.map((session) => <div className="adm-row" key={session.id}><span className="adm-avatar adm-avatar-sm">{session.displayName.slice(0, 1)}</span><span className="adm-row-main"><strong>{session.displayName}</strong><small>{session.email}</small></span><Badge tone={isActiveSession(session) ? "ok" : undefined}>{isActiveSession(session) ? "在线" : "离线"}</Badge><span className="adm-row-side">{date(session.lastSeenAt)}</span></div>)}</div>
    {!recent.length && <Empty>暂无登录活动</Empty>}
    <a className="adm-card-link" href="/admin/sessions">查看全部会话 <Icon name="arrow-right" size={13} /></a>
  </Card>;
}

function AlertsPanel({ errors }: { errors: HomeErrors }) {
  const alerts = Object.values(errors).filter((value): value is string => Boolean(value));
  return <Card title="告警与数据状态" meta={alerts.length ? `${alerts.length} 项待处理` : "当前正常"}>
    {alerts.length ? <ul className="adm-alertlist">{alerts.map((alert, index) => <li key={index}><Dot tone="err" /><span>{alert}</span></li>)}</ul> : <Empty><strong>所有看板数据已同步</strong></Empty>}
  </Card>;
}

function QuickLinks() {
  const links = [
    { href: "/admin/users", icon: "users" as const, title: "用户管理", sub: "账号与默认模式" },
    { href: "/admin/billing", icon: "billing" as const, title: "用量与额度", sub: "模型价格和预算" },
    { href: "/admin/knowledge", icon: "knowledge" as const, title: "知识库", sub: "文档与摄入任务" },
    { href: "/admin/memory", icon: "memory" as const, title: "记忆", sub: "记忆空间与节点" },
  ];
  return <Card title="快捷入口" meta="管理操作"><div className="adm-quick">{links.map((link) => <a href={link.href} key={link.href}><span className="adm-quick-icon"><Icon name={link.icon} size={15} /></span><span className="adm-quick-main"><strong>{link.title}</strong><small>{link.sub}</small></span><Icon name="arrow-right" size={13} /></a>)}</div></Card>;
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
  return <section className="adm-page-inner">
    <PageHeader title="运营总览" sub="系统与用户实时摘要" actions={<><Badge tone={data.runtime ? "ok" : "warn"}>{data.runtime ? "实时同步" : "等待同步"}</Badge><RefreshButton busy={loading} onClick={() => void refresh()} /></>} />
    {Object.keys(errors).length > 0 && <p className="adm-notice adm-notice-warn">部分数据暂不可用，已保留最近一次成功读取的结果。</p>}
    <MetricStrip label="核心指标" items={overviewItems(data)} />
    <div className="adm-dash adm-dash-3"><HealthPanel data={data} errors={errors} /><UsagePanel rows={data.billing} error={errors.billing} /><UserMixPanel users={data.users} error={errors.users} /></div>
    <div className="adm-dash"><ModelCostChart rows={data.billing} error={errors.billing} /><LoginActivityChart sessions={data.sessions} error={errors.sessions} /></div>
    <div className="adm-dash"><RuntimePanel runtime={data.runtime} error={errors.runtime} /><RecentSessionsPanel sessions={data.sessions} error={errors.sessions} /></div>
    <div className="adm-dash"><AlertsPanel errors={errors} /><QuickLinks /></div>
    {lastUpdated && <p className="adm-page-foot">数据更新时间 {date(lastUpdated)}</p>}
  </section>;
}
