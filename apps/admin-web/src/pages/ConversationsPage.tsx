import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  fetchConversation,
  fetchDashboard,
  type AdminConversationSnapshot,
  type AdminDashboardSnapshot,
} from "../api.js";
import { SessionSummary } from "../components/SessionSummary.js";
import { Card, Dot, MetricStrip, PageHeader, RefreshButton } from "../components/AdminUi.js";

const MAX_GENERATION = 1_000_000;

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "暂时无法读取会话投影。";
  if (error.code === "CONTROL_PLANE_DISABLED") return "运行观察尚未在当前部署中启用。";
  if (error.code === "TARGET_NOT_FOUND") return "该会话目标不在当前配置中。";
  if (error.code === "WORKER_UNAVAILABLE") return "运行服务暂时不可用，请稍后刷新。";
  return "无法读取会话投影。";
}

function validGeneration(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation <= MAX_GENERATION ? generation : undefined;
}

export function ConversationsPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [targets, setTargets] = useState<AdminConversationSnapshot[]>([]);
  const [worker, setWorker] = useState<AdminDashboardSnapshot["worker"] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [generation, setGeneration] = useState("");
  const [snapshot, setSnapshot] = useState<AdminConversationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadTargets = useCallback(async () => {
    setLoading(true);
    try {
      const dashboard = await fetchDashboard();
      const initial = dashboard.targets[0] ?? null;
      setWorker(dashboard.worker);
      setTargets(dashboard.targets);
      setSnapshot(initial);
      setSelectedId(initial?.target.id ?? "");
      setGeneration(initial ? String(initial.generation) : "");
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { void loadTargets(); }, [loadTargets]);

  const chooseTarget = (targetId: string): void => {
    const next = targets.find((item) => item.target.id === targetId) ?? null;
    setSelectedId(targetId);
    setSnapshot(next);
    setGeneration(next ? String(next.generation) : "");
  };

  const loadSnapshot = async (): Promise<void> => {
    const selectedGeneration = validGeneration(generation);
    if (!selectedId || selectedGeneration === undefined) return setError("请输入 0 到 1000000 之间的会话代次。");
    setLoading(true);
    try {
      setSnapshot(await fetchConversation(selectedId, selectedGeneration));
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  return <>
    <PageHeader title="运行观察" sub="Worker 只读控制面与会话投影" actions={<RefreshButton busy={loading} label="刷新目标" onClick={() => void loadTargets()} />} />
    {error && <p className={`adm-notice ${snapshot ? "adm-notice-warn" : "adm-notice-err"}`}>{error}</p>}
    <MetricStrip label="运行摘要" items={[
      { label: "Worker", value: worker ? "在线" : "离线", detail: worker ? "控制面已连接" : "等待连接", tone: worker ? "success" : "warning", icon: "pulse" },
      { label: "配置目标", value: String(targets.length), detail: "当前部署", icon: "workspace" },
      { label: "活动投影", value: String(targets.filter((item) => item.session.exists).length), detail: "包含会话数据", tone: "accent", icon: "activity" },
      { label: "队列深度", value: worker ? String(worker.queueDepth) : "—", detail: "待执行项", icon: "sessions" },
    ]} />
    <Card title="Worker 控制面" meta={worker ? `读取于 ${new Date(worker.observedAt).toLocaleString("zh-CN", { hour12: false })}` : "等待检查"}>
      <div className="adm-health"><Dot tone={worker ? "ok" : error ? "err" : "warn"} /><strong>{worker ? "运行中" : error ? "不可用" : "检查中"}</strong><span>{worker ? "只读控制面已连接" : error || "正在读取 Worker 状态"}</span></div>
      {worker && <div className="adm-statgrid" style={{ marginTop: 14 }}><div><strong>{worker.queueDepth}</strong><span>队列深度</span></div><div><strong>{targets.length}</strong><span>目标数量</span></div><div><strong>{targets.filter((item) => item.session.exists).length}</strong><span>会话投影</span></div></div>}
    </Card>
    <Card title="读取会话投影" meta="只读">
      <form className="adm-form" onSubmit={(event) => { event.preventDefault(); void loadSnapshot(); }}>
        <label className="adm-field"><span className="adm-label">会话目标</span><select value={selectedId} onChange={(event) => chooseTarget(event.target.value)} disabled={!targets.length}>
          <option value="">选择已配置目标</option>
          {targets.map((item) => <option key={item.target.id} value={item.target.id}>{item.target.label}</option>)}
        </select></label>
        <label className="adm-field adm-field-sm"><span className="adm-label">会话代次</span><input value={generation} inputMode="numeric" onChange={(event) => setGeneration(event.target.value)} /></label>
        <button className="adm-btn adm-btn-primary" type="submit" disabled={loading || !selectedId}>读取</button>
      </form>
    </Card>
    {loading && !snapshot && <div className="adm-state"><span className="adm-spinner" /><span>正在读取可用目标…</span></div>}
    {snapshot && <Card title={snapshot.target.label} meta={`代次 ${snapshot.generation}`}>
      <SessionSummary session={snapshot.session} />
    </Card>}
  </>;
}
