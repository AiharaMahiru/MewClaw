import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  fetchConversation,
  fetchDashboard,
  type AdminConversationSnapshot,
  type AdminDashboardSnapshot,
} from "../api.js";
import { SessionSummary } from "../components/SessionSummary.js";
import { MetricStrip, PageHeader, RefreshButton, SectionHeading } from "../components/AdminUi.js";

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

  return (
    <section className="workspace">
      <PageHeader eyebrow="只读控制面" title="运行观察" actions={<RefreshButton busy={loading} label="刷新目标" onClick={() => void loadTargets()} />} />
      {error && <p className={`notice ${snapshot ? "stale" : "error"}`}>{error}</p>}
      <MetricStrip label="运行摘要" items={[
        { label: "Worker", value: worker ? "在线" : "离线", detail: worker ? "控制面已连接" : "等待连接", tone: worker ? "success" : "warning", icon: "pulse" },
        { label: "配置目标", value: String(targets.length), detail: "当前部署", icon: "workspace" },
        { label: "活动投影", value: String(targets.filter((item) => item.session.exists).length), detail: "包含会话数据", tone: "accent", icon: "activity" },
        { label: "队列深度", value: worker ? String(worker.queueDepth) : "—", detail: "待执行项", icon: "sessions" },
      ]} />
      <section className="dashboard-panel observer-status-panel"><header className="dashboard-panel-heading"><h3>Worker 控制面</h3><span>{worker ? `读取于 ${new Date(worker.observedAt).toLocaleString("zh-CN", { hour12: false })}` : "等待检查"}</span></header><div className="health-status"><span className={`status-dot ${worker ? "online" : error ? "offline" : "pending"}`} /><strong>{worker ? "运行中" : error ? "不可用" : "检查中"}</strong><span>{worker ? "只读控制面已连接" : error || "正在读取 Worker 状态"}</span></div>{worker && <div className="health-list"><div><span>队列深度</span><strong>{worker.queueDepth}</strong></div><div><span>目标数量</span><strong>{targets.length}</strong></div><div><span>会话投影</span><strong>{targets.filter((item) => item.session.exists).length}</strong></div></div>}</section>
      <form className="control-form" onSubmit={(event) => { event.preventDefault(); void loadSnapshot(); }}>
        <label>会话目标<select value={selectedId} onChange={(event) => chooseTarget(event.target.value)} disabled={!targets.length}>
          <option value="">选择已配置目标</option>
          {targets.map((item) => <option key={item.target.id} value={item.target.id}>{item.target.label}</option>)}
        </select></label>
        <label>会话代次<input value={generation} inputMode="numeric" onChange={(event) => setGeneration(event.target.value)} /></label>
        <button type="submit" disabled={loading || !selectedId}>读取</button>
      </form>
      {loading && !snapshot && <p className="loading">正在读取可用目标...</p>}
      {snapshot && <section className="section-block conversation-detail">
        <SectionHeading title={snapshot.target.label} meta={`代次 ${snapshot.generation}`} />
        <SessionSummary session={snapshot.session} />
      </section>}
    </section>
  );
}
