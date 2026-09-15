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
import { Badge, Card, FilterBar, MetricStrip, PageHeader, RefreshButton, Select, Skeleton, TableSkeleton } from "../components/AdminUi.js";
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

function Drawer(props: { kicker: string; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; danger?: React.ReactNode }) {
  return <>
    <button className="adm-backdrop" type="button" aria-label="关闭详情面板" onClick={props.onClose} />
    <aside className="adm-drawer" aria-label={props.title}>
      <div className="adm-drawer-head"><div><span className="adm-drawer-kicker">{props.kicker}</span><h2 className="adm-drawer-title">{props.title}</h2></div><button className="adm-iconbtn" type="button" aria-label="关闭详情" title="关闭" onClick={props.onClose}><Icon name="close" size={16} /></button></div>
      <div className="adm-drawer-body">{props.children}</div>
      {props.danger && <div className="adm-drawer-danger">{props.danger}</div>}
      {props.footer && <div className="adm-drawer-foot">{props.footer}</div>}
    </aside>
  </>;
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
  return <Drawer kicker="MEMORY CUBE" title={cube.name} onClose={props.onClose}
    danger={<button className="adm-btn adm-btn-danger" type="button" disabled={props.busy} onClick={() => void props.onDelete(cube)}><Icon name="close" size={14} /><span>删除这个记忆空间</span></button>}
    footer={<>创建于 {date(cube.createdAt)} · 最近更新 {date(cube.updatedAt)}</>}>
    <div className="adm-profile">
      <span className="adm-avatar adm-avatar-lg" aria-hidden="true"><Icon name="memory" size={18} /></span>
      <div className="adm-profile-main"><strong>{cube.key}</strong><span>所有者 {owner ? `${owner.displayName} · ${owner.email}` : cube.ownerUserId}</span><div className="adm-profile-badges"><Badge tone="info">{VISIBILITY_TEXT[cube.visibility]}</Badge><Badge>v{cube.revision}</Badge></div></div>
    </div>
    <div className="adm-section"><div className="adm-section-head"><span>基本信息</span><small>乐观锁更新</small></div>
      <label className="adm-field"><span className="adm-label">名称</span><input value={name} disabled={props.busy} onChange={(event) => setName(event.target.value)} /></label>
      <label className="adm-field"><span className="adm-label">可见性</span><Select value={visibility} disabled={props.busy} onChange={(value) => setVisibility(value as MemoryVisibility)} options={Object.entries(VISIBILITY_TEXT).map(([value, label]) => ({ value, label }))} /></label>
      <div className="adm-actions"><button className="adm-btn adm-btn-primary" type="button" disabled={!dirty || props.busy || !name.trim()} onClick={() => void props.onSave(cube, { ...(name.trim() !== cube.name ? { name: name.trim() } : {}), ...(visibility !== cube.visibility ? { visibility } : {}) })}><Icon name="check" size={14} /><span>保存修改</span></button></div>
    </div>
    <div className="adm-section"><div className="adm-section-head"><span>归属</span><small>只读</small></div>
      <div className="adm-statgrid"><div><strong>{cube.visibility === "user_private" ? "私有" : "共享"}</strong><span>可见性</span></div><div><strong>{cube.projectKey ?? "—"}</strong><span>项目键</span></div><div><strong>{cube.agentKey ?? "—"}</strong><span>智能体键</span></div></div>
    </div>
  </Drawer>;
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
  return <Drawer kicker="MEMORY NODE" title={node ? KIND_TEXT[node.kind] : "节点详情"} onClose={props.onClose}
    danger={node ? <button className="adm-btn adm-btn-danger" type="button" disabled={props.busy} onClick={() => void props.onDelete(node.id)}><Icon name="close" size={14} /><span>删除这个节点</span></button> : undefined}
    footer={node ? <>创建于 {date(node.createdAt)} · 最近更新 {date(node.updatedAt)}</> : undefined}>
    {error && <p className="adm-notice adm-notice-err">{error}</p>}
    {!node && !error && <Skeleton lines={4} />}
    {node && <>
      <div className="adm-memparts">{node.parts.map((part, index) => <p className="adm-mempart" key={index}>{partText(part)}</p>)}</div>
      <dl className="adm-usage" style={{ marginTop: 14 }}>
        <div><dt>置信度</dt><dd>{node.confidence ?? "—"}</dd></div>
        <div><dt>状态</dt><dd>{node.status === "active" ? "活跃" : "已归档"}</dd></div>
        <div><dt>来源</dt><dd>{node.source ? node.source.kind : "—"}</dd></div>
        <div><dt>修订</dt><dd>v{node.revision}</dd></div>
      </dl>
      {edges.length > 0 && <div className="adm-section" style={{ marginTop: 14 }}><div className="adm-section-head"><span>关联边</span></div>
        {edges.map((edge) => <div className="adm-identity" key={edge.id}><Badge>{RELATION_TEXT[edge.relation]}</Badge><code>{edge.fromId === node.id ? edge.toId : edge.fromId}</code></div>)}
      </div>}
    </>}
  </Drawer>;
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

  return <>
    <PageHeader title="记忆管理" sub="记忆空间与节点检索" actions={<RefreshButton busy={loading} label="刷新记忆" onClick={() => void refresh()} />} />
    {error && <p className="adm-notice adm-notice-err">{error}</p>}
    {notice && <p className="adm-notice adm-notice-ok"><Icon name="check" size={14} />{notice}</p>}
    <MetricStrip label="记忆摘要" items={[
      { label: "记忆空间", value: String(cubes.length), detail: "全部 cube", tone: "accent", icon: "memory" },
      { label: "私有空间", value: String(privateCount), detail: "user_private", icon: "shield" },
      { label: "共享空间", value: String(sharedCount), detail: "项目/智能体/租户", tone: "success", icon: "users" },
      { label: "检索结果", value: searchResults ? String(searchResults.length) : "—", detail: searchQuery.trim() ? `「${searchQuery.trim()}」` : "尚未检索", tone: "warning", icon: "search" },
    ]} />
    <Card title="语义检索" meta="全部可访问记忆">
      <form className="adm-form" onSubmit={(event) => void runSearch(event)}>
        <label className="adm-field"><span className="adm-label">查询</span><input value={searchQuery} placeholder="输入自然语言查询，检索全部可访问记忆" onChange={(event) => setSearchQuery(event.target.value)} /></label>
        <button className="adm-btn adm-btn-primary" type="submit" disabled={busy || !searchQuery.trim()}><Icon name="search" size={14} /><span>检索</span></button>
      </form>
    </Card>
    {searchResults !== null && <Card title="检索结果" meta={`${searchResults.length} 个节点`} actions={<button className="adm-btn adm-btn-sm" type="button" onClick={() => { setSearchResults(null); setSelectedNodeId(""); }}>清除结果</button>}>
      <div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>内容</th><th>类型</th><th>状态</th><th>置信度</th><th>更新时间</th></tr></thead>
        <tbody>{searchResults.map((node) => <tr key={node.id} className={node.id === selectedNodeId ? "is-selected" : ""} onClick={() => setSelectedNodeId(node.id)}>
          <td><span className="adm-mempreview">{nodePreview(node)}</span><span className="adm-sub">{node.id}</span></td>
          <td><Badge>{KIND_TEXT[node.kind]}</Badge></td>
          <td><Badge tone={node.status === "active" ? "ok" : "err"}>{node.status === "active" ? "活跃" : "已归档"}</Badge></td>
          <td>{node.confidence ?? "—"}</td>
          <td>{date(node.updatedAt)}</td>
        </tr>)}{!searchResults.length && <tr><td className="adm-empty" colSpan={5}>没有命中的记忆节点</td></tr>}</tbody>
      </table></div>
    </Card>}
    <FilterBar query={query} onQuery={setQuery} placeholder="搜索空间名、键或所有者" selected={filter} onSelect={setFilter} resultCount={visible.length} options={[
      { id: "all", label: "全部" }, { id: "user_private", label: "用户私有" }, { id: "project_shared", label: "项目" }, { id: "tenant_shared", label: "租户" },
    ]} />
    <Card title="记忆空间" meta={`${visible.length} 项`}>
      <div className="adm-table-scroll"><table className="adm-table"><thead><tr><th>名称</th><th>所有者</th><th>可见性</th><th>修订</th><th>更新时间</th><th aria-label="查看" /></tr></thead>
        <tbody>{visible.map((cube) => {
          const owner = userLabels.get(cube.ownerUserId);
          return <tr key={cube.id} className={cube.id === selectedCubeId ? "is-selected" : ""} onDoubleClick={() => void openCube(cube.id)}>
            <td><strong>{cube.name}</strong><span className="adm-sub">{cube.key}</span></td>
            <td><strong>{owner?.displayName ?? "未知"}</strong><span className="adm-sub">{owner?.email ?? cube.ownerUserId}</span></td>
            <td><Badge tone={cube.visibility === "user_private" ? "warn" : "ok"}>{VISIBILITY_TEXT[cube.visibility]}</Badge></td>
            <td>v{cube.revision}</td>
            <td>{date(cube.updatedAt)}</td>
            <td><button className="adm-btn adm-btn-sm" type="button" aria-label={`查看 ${cube.name}`} title="查看详情" onClick={() => void openCube(cube.id)}><Icon name="edit" size={13} /><span>详情</span></button></td>
          </tr>;
        })}{!visible.length && !loading && <tr><td className="adm-empty" colSpan={6}>没有符合条件的记忆空间</td></tr>}{loading && <TableSkeleton cols={6} />}</tbody>
      </table></div>
    </Card>
    {selectedNodeId ? <NodeDetail nodeId={selectedNodeId} busy={busy} onClose={() => setSelectedNodeId("")} onDelete={removeNode} />
      : selectedCube ? <CubeDetail cube={selectedCube} users={users} busy={busy} onClose={() => { setSelectedCube(null); setSelectedCubeId(""); }} onSave={saveCube} onDelete={removeCube} />
      : null}
  </>;
}
