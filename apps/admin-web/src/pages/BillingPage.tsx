import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  fetchAdminUsers,
  fetchBillingPrices,
  fetchBillingQuota,
  fetchBillingSummary,
  updateBillingPrice,
  updateBillingQuota,
  type AdminUserSummary,
  type BillingAggregate,
  type BillingModelPrice,
  type BillingQuota,
} from "../api.js";
import { MetricStrip, PageHeader, RefreshButton, SectionHeading } from "../components/AdminUi.js";
import { billingTotals } from "../admin-view-model.js";

function credits(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function usd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}

function tokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function PriceEditor(props: { price: BillingModelPrice; refresh: () => Promise<void>; onError: (message: string) => void }) {
  const [price, setPrice] = useState(props.price);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await updateBillingPrice(price);
      await props.refresh();
    } catch (cause) {
      props.onError(cause instanceof ApiError ? cause.code : "价格保存失败");
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof BillingModelPrice, label: string, disabled = false) => <label className="price-field">{label}<input type="number" min="0" step="0.000001" value={price[key] as number} disabled={disabled} onChange={(event) => setPrice({ ...price, [key]: Number(event.target.value) })} /></label>;
  return <form className="price-row" onSubmit={(event) => void submit(event)}><div><strong>{price.provider}</strong><span className="table-subline">{price.model}</span></div>{field("inputUsdPerMillion", "输入（未命中）")}{field("outputUsdPerMillion", "输出")}{field("cacheReadUsdPerMillion", "缓存命中")}{field("cacheWriteUsdPerMillion", "缓存写入")}{field("reasoningUsdPerMillion", "推理（随输出）", true)}<button type="submit" disabled={busy}>保存</button></form>;
}

function QuotaPanel(props: { users: AdminUserSummary[]; onError: (message: string) => void }) {
  const [userId, setUserId] = useState(props.users[0]?.id ?? "");
  const [quota, setQuota] = useState<BillingQuota | null>(null);
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (nextUserId: string) => {
    if (!nextUserId) return;
    try {
      const next = await fetchBillingQuota(nextUserId);
      setQuota(next);
      setLimit(next.monthlyLimitUsd);
    } catch (cause) {
      props.onError(cause instanceof ApiError ? cause.code : "额度读取失败");
    }
  }, [props.onError]);
  useEffect(() => { void load(userId); }, [load, userId]);
  useEffect(() => { if (!userId && props.users[0]) setUserId(props.users[0].id); }, [props.users, userId]);
  const save = async (): Promise<void> => {
    if (!userId || !Number.isFinite(limit) || limit < 0) return props.onError("额度必须是非负美元金额");
    setBusy(true);
    try { setQuota(await updateBillingQuota(userId, limit)); }
    catch (cause) { props.onError(cause instanceof ApiError ? cause.code : "额度保存失败"); }
    finally { setBusy(false); }
  };
  return <section className="quota-panel"><SectionHeading title="月度额度" meta={quota ? quota.periodStart : "选择用户"} /><div className="quota-form"><label>用户<select value={userId} onChange={(event) => setUserId(event.target.value)}>{props.users.map((user) => <option key={user.id} value={user.id}>{user.displayName} · {user.email}</option>)}</select></label><label>额度（USD）<input type="number" min="0" step="0.000001" value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label><button type="button" onClick={() => void save()} disabled={busy || !userId}>保存额度</button></div>{quota && <div className="quota-stats"><span>本月已用 <strong>{usd(quota.usedUsd)}</strong></span><span>剩余 <strong>{usd(quota.remainingUsd)}</strong></span><span>额度 <strong>{usd(quota.monthlyLimitUsd)}</strong></span></div>}</section>;
}

function UsageTable({ rows, users }: { rows: BillingAggregate[]; users: AdminUserSummary[] }) {
  const labels = new Map(users.map((user) => [user.id, user]));
  return <section className="section-block"><SectionHeading title="用量明细" meta={`${rows.length} 项`} /><div className="table-scroll"><table className="data-table admin-table"><thead><tr><th>用户</th><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>费用（USD）</th></tr></thead><tbody>{rows.map((row) => {
    const user = labels.get(row.userId);
    return <tr key={`${row.periodStart}-${row.userId}-${row.provider}-${row.model}`}><td data-label="用户"><strong>{user?.displayName ?? "未知用户"}</strong><span className="table-subline">{user?.email ?? "账号已移除"}</span></td><td data-label="模型"><strong>{row.model}</strong><span className="table-subline">{row.provider}</span></td><td data-label="调用">{credits(row.calls)}</td><td data-label="输入">{tokens(row.inputTokens)}</td><td data-label="输出">{tokens(row.outputTokens)}</td><td data-label="费用（USD）">{usd(row.totalUsd)}</td></tr>;
  })}{!rows.length && <tr><td className="empty" colSpan={6}>暂无用量记录</td></tr>}</tbody></table></div></section>;
}

export function BillingPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [rows, setRows] = useState<BillingAggregate[]>([]);
  const [prices, setPrices] = useState<BillingModelPrice[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [summary, priceList, userList] = await Promise.all([fetchBillingSummary(), fetchBillingPrices(), fetchAdminUsers()]);
      setRows(summary.rows); setPrices(priceList.prices); setUsers(userList.users); setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(cause instanceof ApiError ? cause.code : "无法加载计费数据");
    } finally { setLoading(false); }
  }, [onUnauthorized]);
  useEffect(() => { void refresh(); }, [refresh]);
  const totals = useMemo(() => billingTotals(rows), [rows]);
  return <section className="workspace">
    <PageHeader eyebrow="模型计费" title="用量与额度" actions={<RefreshButton busy={loading} label="刷新计费" onClick={() => void refresh()} />} />
    {error && <p className="notice error">{error}</p>}
    <MetricStrip label="计费摘要" items={[
      { label: "本月费用", value: usd(totals.totalUsd), detail: `${totals.models} 个模型`, tone: "warning", icon: "billing" },
      { label: "模型调用", value: credits(totals.calls), detail: `${rows.length} 个计费分组`, tone: "accent", icon: "pulse" },
      { label: "Token 总量", value: tokens(totals.tokens), detail: "输入、输出与推理", icon: "activity" },
      { label: "计费用户", value: String(new Set(rows.map((row) => row.userId)).size), detail: `${users.length} 个注册账号`, tone: "success", icon: "users" },
    ]} />
    <QuotaPanel users={users} onError={setError} />
    <UsageTable rows={rows} users={users} />
    <section className="section-block"><SectionHeading title="模型价格" meta="每百万 token · USD" /><div className="price-list">{prices.map((price) => <PriceEditor key={`${price.provider}-${price.model}`} price={price} refresh={refresh} onError={setError} />)}{!prices.length && !loading && <p className="empty">暂无模型价格</p>}</div></section>
  </section>;
}
