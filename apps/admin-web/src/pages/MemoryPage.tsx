import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import {
  ApiError,
  deleteMemoryCube,
  deleteMemoryNode,
  fetchAdminUsers,
  fetchMemoryCube,
  fetchMemoryCubes,
  fetchMemoryNode,
  searchMemory,
  updateMemoryCube,
  type AdminUserSummary,
  type MemoryCube,
  type MemoryEdge,
  type MemoryNode,
  type MemoryPart,
  type MemoryVisibility,
} from "../api.js";
import { FilterBar, MetricStrip, PageHeader, RefreshButton, SectionHeading } from "../components/AdminUi.js";
import { Icon } from "../components/Icon.js";

const VISIBILITY_TEXT: Record<MemoryVisibility, string> = {
  user_private: "用户私有",
  project_shared: "项目共享",
  agent_shared: "智能体共享",
  deployment_shared: "部署共享",
  tenant_shared: "租户共享",
};

const KIND_TEXT: Record<MemoryNode["kind"], string> = {
  preference: "偏好",
  fact: "事实",
  goal: "目标",
  profile: "画像",
  episode: "片段",
  tool_trace: "工具轨迹",
  image: "图像",
  document: "文档",
  other: "其他",
};

const RELATION_TEXT: Record<MemoryEdge["relation"], string> = {
  supports: "支持",
  contradicts: "矛盾",
  derived_from: "派生自",
  related_to: "关联",
  part_of: "属于",
};

function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "暂无记录" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? (cause.status === 403 ? "需要管理员权限" : cause.code) : fallback;
}

function partText(part: MemoryPart): string {
  if (part.modality === "text") return part.text;
  if (part.modality === "image") return `[图像] ${part.alt || part.uri}`;
  if (part.modality === "persona") return `${part.trait}: ${part.value}`;
  return `[工具 ${part.tool}]${part.ok === false ? "（失败）" : ""}`;
}

function nodePreview(node: MemoryNode): string {
  const text = node.parts.map(partText).filter(Boolean).join(" · ");
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function CubeDetail(props: {
  cube: MemoryCube;
  users: AdminUserSummary[];
  busy: boolean;
  onClose: () => void;
  onSave: (cube: MemoryCube, patch: { name?: string; visibility?: MemoryVisibility }) => Promise<void>;
  onDelete: (cube: MemoryCube) => Promise<void>;
}) {
  const { cube } = props;
  const [name, setName] = useState(cube.name);
  const [visibility, setVisibility] = useState<MemoryVisibility>(cube.visibility);
  useEffect(() => { setName(cube.name); setVisibility(cube.visibility); }, [cube]);
  const owner = props.users.find((user) => user.id === cube.ownerUserId);
  const dirty = name.trim() !== cube.name || visibility !== cube.visibility;
  return <aside className="user-editor is-open memory-editor" aria-label="记忆空间详情">
    <div className="user-editor-head"><div><span className="editor-kicker">MEMORY CUBE</span><h2>{cube.name}</h2></div><button className="icon-button" type="button" aria-label="关闭详情" title="关闭" onClick={props.onClose}><Icon name="close" size={17} /></button></div>
    <div className="user-editor-profile"><span className="user-avatar" aria-hidden="true"><Icon name="knowledge" size={18} /></span><div className="user-editor-identity"><strong>{cube.key}</strong><span>所有者 {owner ? `${owner.displayName} · ${owner.email}` : cube.ownerUserId}</span><div className="user-editor-badges"><span className="badge processing">{VISIBILITY_TEXT[cube.visibility]}</span><span className="badge">v{cube.revision}</span></div></div></div>
    <div className="user-editor-form">
      <div className="form-section"><div className="form-section-heading"><span>基本信息</span><small>乐观锁更新</small></div>
        <label className="editor-field"><span className="editor-label">名称</span><input value={name} disabled={props.busy} onChange={(event) => setName(event.target.value)} /></label>
        <label className="editor-field"><span className="editor-label">可见性</span><select value={visibility} disabled={props.busy} onChange={(event) => setVisibility(event.target.value as MemoryVisibility)}>{Object.entries(VISIBILITY_TEXT).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="user-editor-actions"><button className="primary-action" type="button" disabled={!dirty || props.busy || !name.trim()} onClick={() => void props.onSave(cube, { ...(name.trim() !== cube.name ? { name: name.trim() } : {}), ...(visibility !== cube.visibility ? { visibility } : {}) })}><Icon name="check" size={15} /><span>保存修改</span></button><button className="secondary-action" type="button" onClick={props.onClose} disabled={props.busy}>关闭</button></div>
      </div>
      <div className="form-section resource-section"><div className="form-section-heading"><span>归属</span><small>只读</small></div>
        <div className="resource-grid"><div><strong>{cube.visibility === "user_private" ? "私有" : "共享"}</strong><span>可见性</span></div><div><strong>{cube.projectKey ?? "—"}</strong><span>项目键</span></div><div><strong>{cube.agentKey ?? "—"}</strong><span>智能体键</span></div></div>
      </div>
    </div>
    <div className="user-editor-danger"><button className="danger-action" type="button" disabled={props.busy} onClick={() => void props.onDelete(cube)}><Icon name="close" size={14} /><span>删除这个记忆空间</span></button></div>
    <p className="editor-footnote">创建于 {date(cube.createdAt)} · 最近更新 {date(cube.updatedAt)}</p>
  </aside>;
}

function NodeDetail(props: { nodeId: string; onClose: () => void; onDelete: (nodeId: string) => Promise<void>; busy: boolean }) {
  const [node, setNode] = useState<MemoryNode | null>(null);
  const [edges, setEdges] = useState<MemoryEdge[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setNode(null); setEdges([]); setError("");
    void fetchMemoryNode(props.nodeId).then((result) => {
      if (cancelled) return;
      setNode(result.node ?? null); setEdges(result.edges);
    }).catch((cause: unknown) => { if (!cancelled) setError(errorText(cause, "节点读取失败")); });
    return () => { cancelled = true; };
  }, [props.nodeId]);
  return <aside className="user-editor is-open memory-editor" aria-label="记忆节点详情">
    <div className="user-editor-head"><div><span className="editor-kicker">MEMORY NODE</span><h2>{node ? KIND_TEXT[node.kind] : "节点详情"}</h2></div><button className="icon-button" type="button" aria-label="关闭详情" title="关闭" onClick={props.onClose}><Icon name="close" size={17} /></button></div>
    {error && <p className="notice error">{error}</p>}
    {!node && !error && <div className="panel-state"><span>正在读取节点…</span></div>}
    {node && <>
      <div className="memory-node-body">
        {node.parts.map((part, index) => <p className="memory-part" key={index}>{partText(part)}</p>)}
        <dl className="memory-node-meta">
          <div><dt>置信度</dt><dd>{node.confidence ?? "—"}</dd></div>
          <div><dt>状态</dt><dd>{node.status === "active" ? "活跃" : "已归档"}</dd></div>
          <div><dt>来源</dt><dd>{node.source ? node.source.kind : "—"}</dd></div>
          <div><dt>修订</dt><dd>v{node.revision}</dd></div>
        </dl>
        {edges.length > 0 && <div className="memory-edge-list"><span className="editor-label">关联边</span>{edges.map((edge) => <div className="memory-edge" key={edge.id}><span className="badge">{RELATION_TEXT[edge.relation]}</span><code>{edge.fromId === node.id ? edge.toId : edge.fromId}</code></div>)}</div>}
      </div>
      <div className="user-editor-danger"><button className="danger-action" type="button" disabled={props.busy} onClick={() => void props.onDelete(node.id)}><Icon name="close" size={14} /><span>删除这个节点</span></button></div>
      <p className="editor-footnote">创建于 {date(node.createdAt)} · 最近更新 {date(node.updatedAt)}</p>
    </>}
  </aside>;
}

export function MemoryPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [cubes, setCubes] = useState<MemoryCube[]>([]);
  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedCubeId, setSelectedCubeId] = useState("");
  const [selectedCube, setSelectedCube] = useState<MemoryCube | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryNode[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const userLabels = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cubeResult, userResult] = await Promise.all([fetchMemoryCubes(), fetchAdminUsers()]);
      setCubes(cubeResult.cubes);
      setUsers(userResult.users);
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "无法加载记忆空间"));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);
  useEffect(() => { void refresh(); }, [refresh]);

  const openCube = useCallback(async (cubeId: string) => {
    setSelectedCubeId(cubeId);
    setSelectedNodeId("");
    try {
      const result = await fetchMemoryCube(cubeId);
      setSelectedCube(result.cube ?? null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "记忆空间读取失败"));
    }
  }, [onUnauthorized]);

  const runSearch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const term = searchQuery.trim();
    if (!term) return;
    setBusy(true);
    try {
      const result = await searchMemory(term);
      setSearchResults(result.nodes);
      setError("");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "记忆检索失败"));
    } finally {
      setBusy(false);
    }
  };

  const saveCube = async (cube: MemoryCube, patch: { name?: string; visibility?: MemoryVisibility }): Promise<void> => {
    setBusy(true);
    try {
      await updateMemoryCube(cube.id, patch, cube.revision);
      setNotice("记忆空间已更新");
      await refresh();
      await openCube(cube.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "记忆空间保存失败"));
    } finally {
      setBusy(false);
    }
  };

  const removeCube = async (cube: MemoryCube): Promise<void> => {
    if (!window.confirm(`删除记忆空间「${cube.name}」？其中的记忆节点将一并移除。`)) return;
    setBusy(true);
    try {
      await deleteMemoryCube(cube.id);
      setSelectedCubeId(""); setSelectedCube(null);
      setNotice(`已删除「${cube.name}」`);
      await refresh();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "删除失败"));
    } finally {
      setBusy(false);
    }
  };

  const removeNode = async (nodeId: string): Promise<void> => {
    if (!window.confirm("删除这个记忆节点？")) return;
    setBusy(true);
    try {
      await deleteMemoryNode(nodeId);
      setSelectedNodeId("");
      setNotice("节点已删除");
      if (searchQuery.trim()) setSearchResults((await searchMemory(searchQuery.trim())).nodes);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized();
      else setError(errorText(cause, "节点删除失败"));
    } finally {
      setBusy(false);
    }
  };

  const visible = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return cubes.filter((cube) => {
      if (filter !== "all" && cube.visibility !== filter) return false;
      const owner = userLabels.get(cube.ownerUserId);
      return !term || [cube.name, cube.key, owner?.displayName ?? "", owner?.email ?? ""].join(" ").toLocaleLowerCase("zh-CN").includes(term);
    });
  }, [cubes, filter, query, userLabels]);

  const privateCount = cubes.filter((cube) => cube.visibility === "user_private").length;
  const sharedCount = cubes.length - privateCount;

  return <section className="workspace">
    <PageHeader eyebrow="记忆与检索" title="记忆管理" actions={<RefreshButton busy={loading} label="刷新记忆" onClick={() => void refresh()} />} />
    {error && <p className="notice error">{error}</p>}
    {notice && <p className="notice success"><Icon name="check" size={14} />{notice}</p>}
    <MetricStrip label="记忆摘要" items={[
      { label: "记忆空间", value: String(cubes.length), detail: "全部 cube", tone: "accent", icon: "knowledge" },
      { label: "私有空间", value: String(privateCount), detail: "user_private", icon: "shield" },
      { label: "共享空间", value: String(sharedCount), detail: "项目/智能体/租户", tone: "success", icon: "users" },
      { label: "检索结果", value: searchResults ? String(searchResults.length) : "—", detail: searchQuery.trim() ? `「${searchQuery.trim()}」` : "尚未检索", tone: "warning", icon: "search" },
    ]} />
    <form className="control-form memory-search-form" onSubmit={(event) => void runSearch(event)}>
      <label>语义检索<input value={searchQuery} placeholder="输入自然语言查询，检索全部可访问记忆" onChange={(event) => setSearchQuery(event.target.value)} /></label>
      <button type="submit" disabled={busy || !searchQuery.trim()}><Icon name="search" size={14} /><span>检索</span></button>
    </form>
    {searchResults !== null && <section className="section-block"><SectionHeading title="检索结果" meta={`${searchResults.length} 个节点`} actions={<button type="button" onClick={() => { setSearchResults(null); setSelectedNodeId(""); }}>清除结果</button>} />
      <div className="table-scroll"><table className="data-table admin-table"><thead><tr><th>内容</th><th>类型</th><th>状态</th><th>置信度</th><th>更新时间</th></tr></thead>
        <tbody>{searchResults.map((node) => <tr key={node.id} className={node.id === selectedNodeId ? "is-selected" : ""} onClick={() => setSelectedNodeId(node.id)}>
          <td data-label="内容"><span className="memory-preview">{nodePreview(node)}</span><span className="table-subline">{node.id}</span></td>
          <td data-label="类型"><span className="badge">{KIND_TEXT[node.kind]}</span></td>
          <td data-label="状态"><span className={`badge ${node.status === "active" ? "active" : "disabled"}`}>{node.status === "active" ? "活跃" : "已归档"}</span></td>
          <td data-label="置信度">{node.confidence ?? "—"}</td>
          <td data-label="更新时间">{date(node.updatedAt)}</td>
        </tr>)}{!searchResults.length && <tr><td className="empty" colSpan={5}>没有命中的记忆节点</td></tr>}</tbody>
      </table></div>
    </section>}
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索空间名、键或所有者" selected={filter} onSelect={setFilter} resultCount={visible.length} options={[
      { id: "all", label: "全部" }, { id: "user_private", label: "用户私有" }, { id: "project_shared", label: "项目" }, { id: "tenant_shared", label: "租户" },
    ]} />
    <div className="user-management-grid">
      <section className="section-block user-list-panel"><SectionHeading title="记忆空间" meta={`${visible.length} 项`} />
        <div className="table-scroll"><table className="data-table admin-table user-table"><thead><tr><th>名称</th><th>所有者</th><th>可见性</th><th>修订</th><th>更新时间</th><th aria-label="查看" /></tr></thead>
          <tbody>{visible.map((cube) => {
            const owner = userLabels.get(cube.ownerUserId);
            return <tr key={cube.id} className={cube.id === selectedCubeId ? "is-selected" : ""} onDoubleClick={() => void openCube(cube.id)}>
              <td data-label="名称"><strong>{cube.name}</strong><span className="table-subline">{cube.key}</span></td>
              <td data-label="所有者"><strong>{owner?.displayName ?? "未知"}</strong><span className="table-subline">{owner?.email ?? cube.ownerUserId}</span></td>
              <td data-label="可见性"><span className={`badge ${cube.visibility === "user_private" ? "pending" : "completed"}`}>{VISIBILITY_TEXT[cube.visibility]}</span></td>
              <td data-label="修订">v{cube.revision}</td>
              <td data-label="更新时间">{date(cube.updatedAt)}</td>
              <td data-label="查看"><button className="table-edit-button" type="button" aria-label={`查看 ${cube.name}`} title="查看详情" onClick={() => void openCube(cube.id)}><Icon name="edit" size={14} /><span>详情</span></button></td>
            </tr>;
          })}{!visible.length && !loading && <tr><td className="empty" colSpan={6}>没有符合条件的记忆空间</td></tr>}{loading && <tr><td className="empty loading-row" colSpan={6}><span className="loading-spinner" />正在读取记忆空间</td></tr>}</tbody>
        </table></div>
      </section>
      {(selectedCube || selectedNodeId) && <button className="editor-backdrop" type="button" aria-label="关闭详情面板" onClick={() => { setSelectedCube(null); setSelectedCubeId(""); setSelectedNodeId(""); }} />}
      {selectedNodeId ? <NodeDetail nodeId={selectedNodeId} busy={busy} onClose={() => setSelectedNodeId("")} onDelete={removeNode} />
        : selectedCube ? <CubeDetail cube={selectedCube} users={users} busy={busy} onClose={() => { setSelectedCube(null); setSelectedCubeId(""); }}
          onSave={saveCube}
          onDelete={removeCube} />
        : null}
    </div>
  </section>;
}
