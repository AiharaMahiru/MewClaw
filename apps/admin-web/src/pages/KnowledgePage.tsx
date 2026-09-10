import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  documentAction,
  fetchRuns,
  fetchSnapshot,
  uploadDocument,
  type DocumentAction,
  type IngestionRun,
  type KnowledgeCategory,
  type KnowledgeDocument,
  type KnowledgeSnapshot,
  type KnowledgeVisibility,
} from "../api.js";
import { MetricStrip, PageHeader, RefreshButton, SectionHeading } from "../components/AdminUi.js";

const CATEGORIES: KnowledgeCategory[] = [
  "general", "product_manual", "technical_spec", "project_document", "policy_process", "faq",
];
const STATUS_TEXT: Record<string, string> = { processing: "处理中", active: "可用", superseded: "被取代", failed: "失败", deleted: "已归档" };
const STAGE_TEXT: Record<string, string> = { queued: "排队", inspecting: "检查源", extracting: "提取", chunking: "分块", embedding: "嵌入", indexing: "建索引", completed: "完成", failed: "失败" };

function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function actionError(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.code : fallback;
}

function useKnowledgeData(onUnauthorized: () => void) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot | null>(null);
  const [runs, setRuns] = useState<IngestionRun[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSnapshot, nextRuns] = await Promise.all([fetchSnapshot(), fetchRuns()]);
      setSnapshot(nextSnapshot);
      setRuns(nextRuns.runs);
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError("无法加载知识数据。");
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);
  useEffect(() => { void refresh(); }, [refresh]);
  const processing = useMemo(() => runs.some((run) => run.status === "processing"), [runs]);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [processing, refresh]);
  return { snapshot, runs, error, setError, refresh, loading };
}

function UploadPanel(props: { refresh: () => Promise<void>; setError: (value: string) => void; onUnauthorized: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [visibility, setVisibility] = useState<KnowledgeVisibility>("user_private");
  const [category, setCategory] = useState<KnowledgeCategory>("general");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    props.setError("");
    try {
      await uploadDocument(file, visibility, category, tags.split(",").map((tag) => tag.trim()).filter(Boolean));
      await props.refresh();
      setFile(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) props.onUnauthorized();
      else props.setError(actionError(cause, "上传失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section-block" aria-labelledby="upload-heading">
      <SectionHeading id="upload-heading" title="上传文档" />
      <form className="upload-form" onSubmit={(event) => void submit(event)}>
        <label className="file-picker">选择文件<input type="file" accept=".md,.markdown,.txt,.csv,.json,.log,.ts,.js,.py,.yaml,.yml,.html,.xml" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
        <label>可见性<select value={visibility} onChange={(event) => setVisibility(event.target.value as KnowledgeVisibility)}><option value="user_private">私有</option><option value="bot_shared">共享</option></select></label>
        <label>分类<select value={category} onChange={(event) => setCategory(event.target.value as KnowledgeCategory)}>{CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label className="tag-field">标签<input value={tags} placeholder="逗号分隔，最多 8 个" onChange={(event) => setTags(event.target.value)} /></label>
        <button type="submit" disabled={busy || !file}>{busy ? "上传中" : "上传并摄入"}</button>
      </form>
    </section>
  );
}

function DocumentActions(props: { document: KnowledgeDocument; refresh: () => Promise<void>; setError: (value: string) => void; onUnauthorized: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (action: DocumentAction, visibility?: KnowledgeVisibility): Promise<void> => {
    setBusy(true);
    props.setError("");
    try {
      await documentAction(props.document.docId, action, visibility);
      await props.refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) props.onUnauthorized();
      else props.setError(actionError(cause, "操作失败"));
    } finally {
      setBusy(false);
    }
  };
  const document = props.document;
  if (!document.canManage) return null;
  return <div className="table-actions">
    {document.status === "active" && <button type="button" disabled={busy} onClick={() => void run("archive")}>归档</button>}
    {document.status === "deleted" && <button type="button" disabled={busy} onClick={() => void run("restore")}>恢复</button>}
    {["active", "deleted", "failed"].includes(document.status) && <>
      <button type="button" disabled={busy} onClick={() => void run("set_visibility", document.visibility === "user_private" ? "bot_shared" : "user_private")}>转为{document.visibility === "user_private" ? "共享" : "私有"}</button>
      <button type="button" disabled={busy} onClick={() => void run("reindex")}>重索引</button>
    </>}
  </div>;
}

function DocumentsPanel(props: { documents: KnowledgeDocument[]; refresh: () => Promise<void>; setError: (value: string) => void; onUnauthorized: () => void }) {
  return (
    <section className="section-block" aria-labelledby="documents-heading">
      <SectionHeading id="documents-heading" title="文档" meta={`${props.documents.length} 项`} />
      <div className="table-scroll"><table className="data-table"><thead><tr><th>名称</th><th>可见性</th><th>版本</th><th>状态</th><th>块</th><th>分类</th><th>操作</th></tr></thead>
        <tbody>{props.documents.map((document) => <tr key={document.docId}>
          <td data-label="名称">{document.name}</td><td data-label="可见性">{document.visibility === "user_private" ? "私有" : "共享"}</td><td data-label="版本">v{document.version}</td>
          <td data-label="状态"><span className={`badge ${document.status}`}>{STATUS_TEXT[document.status] ?? document.status}</span></td><td data-label="块">{document.chunkCount}</td><td data-label="分类">{document.category}</td>
          <td data-label="操作"><DocumentActions document={document} refresh={props.refresh} setError={props.setError} onUnauthorized={props.onUnauthorized} /></td>
        </tr>)}{!props.documents.length && <tr><td className="empty" colSpan={7}>暂无文档。</td></tr>}</tbody>
      </table></div>
    </section>
  );
}

function RunsPanel({ runs }: { runs: IngestionRun[] }) {
  return (
    <section className="section-block" aria-labelledby="runs-heading">
      <SectionHeading id="runs-heading" title="摄入任务" meta={`${runs.length} 项`} />
      <div className="table-scroll"><table className="data-table"><thead><tr><th>文件</th><th>可见性</th><th>阶段</th><th>进度</th><th>状态</th><th>错误</th></tr></thead>
        <tbody>{runs.map((run) => <tr key={run.runId}>
          <td data-label="文件">{run.fileName}</td><td data-label="可见性">{run.visibility === "user_private" ? "私有" : "共享"}</td><td data-label="阶段">{STAGE_TEXT[run.stage] ?? run.stage}</td>
          <td data-label="进度"><div className="progress" aria-label={`${run.progress}%`}><div className="fill" style={{ width: `${run.progress}%` }} /></div></td>
          <td data-label="状态"><span className={`badge ${run.status}`}>{run.status === "processing" ? "处理中" : run.status === "completed" ? "完成" : "失败"}</span></td><td data-label="错误">{run.errorCode ?? "-"}</td>
        </tr>)}{!runs.length && <tr><td className="empty" colSpan={6}>暂无摄入任务。</td></tr>}</tbody>
      </table></div>
    </section>
  );
}

function KnowledgeMetrics({ snapshot }: { snapshot: KnowledgeSnapshot }) {
  const { summary } = snapshot;
  return <MetricStrip label="知识库摘要" items={[
    { label: "可用文档", value: String(summary.activeDocuments), detail: `${summary.totalVersions} 个版本`, tone: "success", icon: "knowledge" },
    { label: "私有文档", value: String(summary.privateDocuments), detail: "当前用户范围", tone: "accent", icon: "shield" },
    { label: "共享文档", value: String(summary.sharedDocuments), detail: `${summary.totalChunks} 个内容块`, icon: "users" },
    { label: "总容量", value: bytes(summary.totalBytes), detail: `${summary.archivedDocuments} 个已归档`, icon: "workspace" },
  ]} />;
}

export function KnowledgePage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { snapshot, runs, error, setError, refresh, loading } = useKnowledgeData(onUnauthorized);
  return <section className="workspace">
    <PageHeader eyebrow="内容与检索" title="知识库" actions={<RefreshButton busy={loading} label="刷新知识库" onClick={() => void refresh()} />} />
    {error && <p className="notice error">{error}</p>}
    {snapshot && <KnowledgeMetrics snapshot={snapshot} />}
    <UploadPanel refresh={refresh} setError={setError} onUnauthorized={onUnauthorized} />
    <DocumentsPanel documents={snapshot?.documents ?? []} refresh={refresh} setError={setError} onUnauthorized={onUnauthorized} />
    <RunsPanel runs={runs} />
  </section>;
}
