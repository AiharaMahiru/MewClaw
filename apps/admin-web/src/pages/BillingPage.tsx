import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  addBillingCredit,
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
import { Card, MetricStrip, PageHeader, RefreshButton, Select } from "../components/AdminUi.js";
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
  const field = (key: keyof BillingModelPrice, label: string, disabled = false) => <label className="adm-field adm-field-sm"><span className="adm-label">{label}</span><input type="number" min="0" step="0.000001" value={price[key] as number} disabled={disabled} onChange={(event) => setPrice({ ...price, [key]: Number(event.target.value) })} /></label>;
  return <form className="adm-price-row" onSubmit={(event) => void submit(event)}>
    <div className="adm-price-name"><strong>{price.provider}</strong><span className="adm-sub">{price.model}</span></div>
    {field("inputUsdPerMillion", "输入（未命中）")}{field("outputUsdPerMillion", "输出")}{field("cacheReadUsdPerMillion", "缓存命中")}{field("cacheWriteUsdPerMillion", "缓存写入")}{field("reasoningUsdPerMillion", "推理（随输出）", true)}
    <button className="adm-btn adm-btn-sm" type="submit" disabled={busy}>保存</button>
  </form>;
}

function QuotaPanel(props: { users: AdminUserSummary[]; onError: (message: string) => void }) {
  const [userId, setUserId] = useState(props.users[0]?.id ?? "");
  const [quota, setQuota] = useState<BillingQuota | null>(null);
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [credit, setCredit] = useState("");
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
  const recharge = async (delta: number): Promise<void> => {
    if (!userId) return;
    if (!Number.isFinite(delta) || delta <= 0) return props.onError("充值金额必须是正数");
    setBusy(true);
    try {
      const next = await addBillingCredit(userId, delta);
      setQuota(next);
      setLimit(next.monthlyLimitUsd);
      setCredit("");
    } catch (cause) { props.onError(cause instanceof ApiError ? cause.code : "充值失败"); }
    finally { setBusy(false); }
  };
  return <Card title="月度额度" meta={quota ? `周期起点 ${quota.periodStart}` : "选择用户"}>
    <form className="adm-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="adm-field"><span className="adm-label">用户</span><Select value={userId} onChange={setUserId} placeholder="选择用户" options={props.users.map((user) => ({ value: user.id, label: `${user.displayName} · ${user.email}` }))} /></label>
      <label className="adm-field adm-field-sm"><span className="adm-label">额度（USD）</span><input type="number" min="0" step="0.000001" value={limit} onChange={(event) => setLimit(Number(event.target.value))} /></label>
      <button className="adm-btn adm-btn-primary" type="submit" disabled={busy || !userId}>保存额度</button>
    </form>
    {quota && <div className="adm-statgrid" style={{ marginTop: 14 }}><div><strong>{usd(quota.usedUsd)}</strong><span>本月已用</span></div><div><strong>{usd(quota.remainingUsd)}</strong><span>剩余</span></div><div><strong>{usd(quota.monthlyLimitUsd)}</strong><span>额度</span></div></div>}
    <div className="adm-section" style={{ marginTop: 14 }}><div className="adm-section-head"><span>快速充值</span><small>在现有额度上增加</small></div>
      <div className="adm-recharge">
        {[5, 10, 20, 50].map((delta) => <button key={delta} className="adm-btn adm-btn-sm" type="button" disabled={busy || !userId} onClick={() => void recharge(delta)}>+${delta}</button>)}
        <input type="number" min="0" step="0.000001" placeholder="自定义金额" value={credit} onChange={(event) => setCredit(event.target.value)} />
        <button className="adm-btn adm-btn-sm" type="button" disabled={busy || !userId || !credit.trim()} onClick={() => void recharge(Number(credit))}>充值</button>
      </div>
    </div>
  </Card>;
}

function UsageTable({ rows, users }: { rows: BillingAggregate[]; users: AdminUserSummary[] }) {
  const labels = new Map(users.map((user) => [user.id, user]));
  return <Card title="用量明细" meta={`${rows.length} 项`}>
    <div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>用户</th><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>费用（USD）</th></tr></thead><tbody>{rows.map((row) => {
      const user = labels.get(row.userId);
      return <tr key={`${row.periodStart}-${row.userId}-${row.provider}-${row.model}`}>
        <td><strong>{user?.displayName ?? "未知用户"}</strong><span className="adm-sub">{user?.email ?? "账号已移除"}</span></td>
        <td><strong>{row.model}</strong><span className="adm-sub">{row.provider}</span></td>
        <td>{credits(row.calls)}</td><td>{tokens(row.inputTokens)}</td><td>{tokens(row.outputTokens)}</td><td>{usd(row.totalUsd)}</td>
      </tr>;
    })}{!rows.length && <tr><td className="adm-empty" colSpan={6}>暂无用量记录</td></tr>}</tbody></table></div>
  </Card>;
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
  return <>
    <PageHeader title="用量与额度" sub="模型计费" actions={<RefreshButton busy={loading} label="刷新计费" onClick={() => void refresh()} />} />
    {error && <p className="adm-notice adm-notice-err">{error}</p>}
    <MetricStrip label="计费摘要" items={[
      { label: "本月费用", value: usd(totals.totalUsd), detail: `${totals.models} 个模型`, tone: "warning", icon: "billing" },
      { label: "模型调用", value: credits(totals.calls), detail: `${rows.length} 个计费分组`, tone: "accent", icon: "pulse" },
      { label: "Token 总量", value: tokens(totals.tokens), detail: "输入、输出与推理", icon: "activity" },
      { label: "计费用户", value: String(new Set(rows.map((row) => row.userId)).size), detail: `${users.length} 个注册账号`, tone: "success", icon: "users" },
    ]} />
    <QuotaPanel users={users} onError={setError} />
    <UsageTable rows={rows} users={users} />
    <Card title="模型价格" meta="每百万 token · USD">
      <div className="adm-pricelist">{prices.map((price) => <PriceEditor key={`${price.provider}-${price.model}`} price={price} refresh={refresh} onError={setError} />)}{!prices.length && !loading && <p className="adm-empty">暂无模型价格</p>}</div>
    </Card>
  </>;
}
