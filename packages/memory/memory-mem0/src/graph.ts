import { randomUUID } from "node:crypto";

import type { Scope } from "dsh-lark-contracts";
import type {
  MemoryCommand,
  MemoryEdge,
  MemoryEdgeInput,
  MemoryHit,
  MemoryNode,
  MemoryNodeInput,
  MemoryNodePatch,
  MemoryResult,
  MemoryService,
} from "dsh-memory";

import { ACCESSIBLE_CUBE, EDITABLE_CUBE } from "./acl.js";
import { assertMetadata, assertParts, primaryModality, searchableText } from "./content.js";
import { MemoryCubeStore } from "./graph-cubes.js";
import { edgeFromRow, nodeFromRow, scopeParams, type EdgeRow, type Mem0ClientPort, type NodeRow } from "./graph-types.js";
import { cubeId, memoryId, memoryScopeIds } from "./identifiers.js";
import type { MemoryDatabase } from "./database.js";

export type { Mem0ClientPort } from "./graph-types.js";

export class MemoryGraphStore extends MemoryCubeStore implements MemoryService {
  constructor(database: MemoryDatabase, mem0: Mem0ClientPort | undefined, logger: { warn(message: string): void }) {
    super(database, mem0, logger);
  }

  enabled(): boolean { return true; }

  async execute(scope: Scope, command: MemoryCommand): Promise<MemoryResult> {
    switch (command.op) {
      case "create": return this.createNode(scope, command.node);
      case "read": return this.readNode(scope, command.id, command.includeEdges ?? true);
      case "update": return this.updateNode(scope, command.id, command.patch, command.expectedRevision);
      case "delete": return this.deleteNode(scope, command.id, command.hard ?? false);
      case "search": return this.searchNodes(scope, command);
      case "link": return this.link(scope, command.edge);
      case "unlink": return this.unlink(scope, command.edgeId);
      case "cube_create": return this.createCube(scope, command.cube);
      case "cube_read": return this.readCube(scope, command.id);
      case "cube_update": return this.updateCube(scope, command.id, command.patch, command.expectedRevision);
      case "cube_delete": return this.deleteCube(scope, command.id);
      case "cube_list": return this.listCubes(scope);
      case "compose": return this.compose(scope, command.cubeIds);
      case "feedback": return this.feedback(scope, command.instruction, command.cubeId);
    }
  }

  async recall(scope: Scope, query: string): Promise<MemoryHit[]> {
    try {
      const result = await this.searchNodes(scope, { op: "search", query, limit: 8 });
      const hits: MemoryHit[] = result.nodes.map((node, rank) => ({
        content: searchableText(node.parts), rank, nodeId: node.id, cubeId: node.cubeId,
        ...(node.parts[0]?.modality ? { modality: node.parts[0].modality } : {}),
      }));
      return hits;
    } catch {
      return [];
    }
  }

  async remember(scope: Scope, userText: string, assistantText: string, capture?: Parameters<MemoryService["remember"]>[3]): Promise<void> {
    const parts = capture?.parts?.length ? capture.parts : [{ modality: "text" as const, text: `用户：${userText}\n助手：${assistantText.slice(0, 100_000)}` }];
    await this.createNode(scope, {
      ...(capture?.cubeId ? { cubeId: capture.cubeId } : {}), kind: capture?.kind ?? "episode", parts,
      ...(capture?.metadata ? { metadata: capture.metadata } : {}), ...(capture?.source ? { source: capture.source } : { source: { kind: "conversation" as const } }),
    });
  }

  protected async createNode(scope: Scope, input: MemoryNodeInput): Promise<MemoryResult> {
    assertParts(input.parts); assertMetadata(input.metadata);
    const id = randomUUID();
    const row = await this.database.transaction(async (tx) => {
      const selectedCube = input.cubeId
        ? await tx.query<{ id: string }>(`SELECT c.id FROM memory_cubes c WHERE c.id=$5 AND ${ACCESSIBLE_CUBE}`, [...scopeParams(scope), input.cubeId])
        : { rows: [] };
      const cube = selectedCube.rows[0]?.id ?? await this.ensureDefaultCube(scope, tx);
      if (input.cubeId && !selectedCube.rows[0]) throw new Error("MEMORY_CUBE_NOT_FOUND");
      const inserted = await tx.query<NodeRow>(
        `INSERT INTO memory_nodes (id,cube_id,tenant_id,bot_id,deployment_id,author_user_id,kind,modality,parts,searchable_text,metadata,confidence,source)
         SELECT $5,c.id,$1,$2,$3,$4,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12::jsonb FROM memory_cubes c WHERE c.id=$13 AND ${EDITABLE_CUBE} RETURNING *`,
        [...scopeParams(scope), id, input.kind, primaryModality(input.parts), JSON.stringify(input.parts), searchableText(input.parts), JSON.stringify(input.metadata ?? {}), input.confidence ?? null, JSON.stringify(input.source ?? null), cube],
      );
      if (!inserted.rows[0]) throw new Error("MEMORY_CUBE_NOT_EDITABLE");
      return inserted.rows[0];
    });
    const node = nodeFromRow(row);
    void this.indexNode(scope, node).catch((error) => this.logger.warn(`memory-mem0: index failed (${error instanceof Error ? error.message : "unknown"})`));
    return { op: "created", node };
  }

  private async indexNode(scope: Scope, node: MemoryNode): Promise<void> {
    if (!this.mem0) return;
    const ids = memoryScopeIds(scope);
    const response = await this.mem0.add([{ role: "user", content: searchableText(node.parts) }], {
      ...ids, metadata: { memory_node_id: node.id, cube_id: node.cubeId, modality: node.parts[0]?.modality ?? "text" }, infer: true,
    });
    const indexedId = Array.isArray(response) ? response[0]?.id : response?.results?.[0]?.id;
    if (!indexedId) return;
    const updated = await this.database.query<{ status: string }>(
      `UPDATE memory_nodes SET mem0_id=$1,updated_at=now() WHERE id=$2 AND status='active' RETURNING status`,
      [indexedId, node.id],
    );
    if (updated.rows.length === 0 && this.mem0.delete) await this.mem0.delete(indexedId);
  }

  private async readNode(scope: Scope, id: string, includeEdges: boolean): Promise<MemoryResult> {
    const row = await this.findNode(scope, id);
    if (!row) return { op: "read", edges: [] };
    const edges = includeEdges ? await this.edgesFor(scope, [id]) : [];
    return { op: "read", node: nodeFromRow(row), edges };
  }

  private async findNode(scope: Scope, id: string): Promise<NodeRow | undefined> {
    const rows = await this.database.query<NodeRow>(`SELECT n.* FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id WHERE n.id=$5 AND n.status='active' AND ${ACCESSIBLE_CUBE}`, [...scopeParams(scope), id]);
    return rows.rows[0];
  }

  protected async searchNodes(scope: Scope, command: Extract<MemoryCommand, { op: "search" }>): Promise<Extract<MemoryResult, { op: "search" }>> {
    const limit = Math.min(Math.max(command.limit ?? 8, 1), 50);
    const cubeRows = await this.database.query<{ id: string }>(`SELECT c.id FROM memory_cubes c WHERE ${ACCESSIBLE_CUBE}`, scopeParams(scope));
    if (cubeRows.rows.length === 0) return { op: "search", nodes: [], edges: [] };
    const visibleIds = cubeRows.rows.map((row) => row.id);
    const requestedIds = command.cubeIds?.length
      ? visibleIds.filter((id) => command.cubeIds!.includes(cubeId(id)))
      : visibleIds;
    if (requestedIds.length === 0) return { op: "search", nodes: [], edges: [] };
    const semantic = await this.semanticNodes(scope, command.query, limit, requestedIds);
    const params: unknown[] = [
      ...scopeParams(scope), command.query, requestedIds, limit,
      command.modalities?.length ? command.modalities : null,
      command.kinds?.length ? command.kinds : null,
    ];
    const rows = await this.database.query<NodeRow>(
      `SELECT n.* FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id
       WHERE n.status='active' AND ${ACCESSIBLE_CUBE} AND n.cube_id=ANY($6::uuid[])
         AND n.searchable_text ILIKE '%' || $5 || '%'
         AND ($8::text[] IS NULL OR n.modality=ANY($8::text[]))
         AND ($9::text[] IS NULL OR n.kind=ANY($9::text[]))
       ORDER BY n.updated_at DESC LIMIT $7`,
      params,
    );
    const lexical = rows.rows.map(nodeFromRow);
    const nodes = [...semantic, ...lexical.filter((node) => !semantic.some((hit) => hit.id === node.id))].slice(0, limit);
    const edges = await this.edgesFor(scope, nodes.map((node) => node.id));
    return { op: "search", nodes, edges };
  }

  private async semanticNodes(scope: Scope, query: string, limit: number, cubeIds: string[]): Promise<MemoryNode[]> {
    if (!this.mem0 || !query.trim()) return [];
    try {
      const ids = memoryScopeIds(scope);
      const response = await this.mem0.search(query, { filters: { agent_id: ids.agentId }, topK: Math.min(limit * 2, 50) });
      const nodeIds = response.results
        .map((item) => item.metadata?.memory_node_id)
        .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id));
      if (nodeIds.length === 0) return [];
      const rows = await this.database.query<NodeRow>(`SELECT n.* FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id WHERE n.id=ANY($5::uuid[]) AND n.cube_id=ANY($6::uuid[]) AND n.status='active' AND ${ACCESSIBLE_CUBE}`, [...scopeParams(scope), nodeIds, cubeIds]);
      const byId = new Map(rows.rows.map((row) => [row.id, nodeFromRow(row)]));
      return nodeIds.map((id) => byId.get(id)).filter((node): node is MemoryNode => Boolean(node)).slice(0, limit);
    } catch {
      return [];
    }
  }

  private async edgesFor(scope: Scope, nodeIds: string[]): Promise<MemoryEdge[]> {
    if (nodeIds.length === 0) return [];
    const rows = await this.database.query<EdgeRow>(`SELECT e.* FROM memory_edges e JOIN memory_cubes c ON c.id=e.cube_id WHERE (e.from_node_id=ANY($5::uuid[]) OR e.to_node_id=ANY($5::uuid[])) AND ${ACCESSIBLE_CUBE}`, [...scopeParams(scope), nodeIds]);
    return rows.rows.map(edgeFromRow);
  }

  protected async updateNode(scope: Scope, id: string, patch: MemoryNodePatch, expectedRevision?: number): Promise<MemoryResult> {
    if (patch.parts) assertParts(patch.parts); assertMetadata(patch.metadata);
    const current = await this.database.query<NodeRow>(`SELECT n.* FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id WHERE n.id=$5 AND n.status='active' AND ${EDITABLE_CUBE}`, [...scopeParams(scope), id]);
    const row = current.rows[0];
    if (!row) throw new Error("MEMORY_NOT_FOUND");
    if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Error("MEMORY_REVISION_CONFLICT");
    const parts = patch.parts ?? row.parts;
    const updated = await this.database.query<NodeRow>(
      `UPDATE memory_nodes n SET kind=$5,modality=$6,parts=$7::jsonb,searchable_text=$8,metadata=$9::jsonb,confidence=$10,source=$11::jsonb,status=$12,revision=n.revision+1,updated_at=now()
       FROM memory_cubes c WHERE n.id=$13 AND n.cube_id=c.id AND ${EDITABLE_CUBE} RETURNING n.*`,
      [...scopeParams(scope), patch.kind ?? row.kind, primaryModality(parts), JSON.stringify(parts), searchableText(parts), JSON.stringify(patch.metadata ?? row.metadata), patch.confidence ?? row.confidence, JSON.stringify(patch.source ?? row.source), patch.status ?? row.status, id],
    );
    if (!updated.rows[0]) throw new Error("MEMORY_NOT_FOUND");
    const node = nodeFromRow(updated.rows[0]);
    if (this.mem0 && updated.rows[0].mem0_id) {
      const indexId = updated.rows[0].mem0_id;
      if (node.status === "archived" && this.mem0.delete) void this.mem0.delete(indexId).catch(() => undefined);
      else if (this.mem0.update) void this.mem0.update(indexId, { text: searchableText(parts) }).catch(() => undefined);
    }
    return { op: "updated", node };
  }

  protected async deleteNode(scope: Scope, id: string, hard: boolean): Promise<MemoryResult> {
    const current = await this.database.query<NodeRow>(
      `SELECT n.* FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id
       WHERE n.id=$5 AND n.status='active' AND ${EDITABLE_CUBE}`,
      [...scopeParams(scope), id],
    );
    const node = current.rows[0];
    if (!node) throw new Error("MEMORY_NOT_FOUND");
    const sql = hard
      ? `DELETE FROM memory_nodes n USING memory_cubes c WHERE n.id=$5 AND n.cube_id=c.id AND ${EDITABLE_CUBE}`
      : `UPDATE memory_nodes n SET status='archived',revision=n.revision+1,updated_at=now() FROM memory_cubes c WHERE n.id=$5 AND n.cube_id=c.id AND ${EDITABLE_CUBE}`;
    await this.database.query(sql, [...scopeParams(scope), id]);
    if (this.mem0?.delete && node.mem0_id) {
      void this.mem0.delete(node.mem0_id).catch((error) => this.logger.warn(`memory-mem0: index delete failed (${error instanceof Error ? error.message : "unknown"})`));
    }
    return { op: "deleted", id: memoryId(id), hard };
  }

  private async link(scope: Scope, input: MemoryEdgeInput): Promise<MemoryResult> {
    const rows = await this.database.query<{ id: string; cube_id: string }>(`SELECT n.id,n.cube_id FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id WHERE n.id=ANY($5::uuid[]) AND n.status='active' AND ${EDITABLE_CUBE}`, [...scopeParams(scope), [input.fromId, input.toId]]);
    if (rows.rows.length !== 2 || rows.rows[0]!.cube_id !== rows.rows[1]!.cube_id) throw new Error("MEMORY_EDGE_SCOPE_INVALID");
    const inserted = await this.database.query<EdgeRow>(`INSERT INTO memory_edges (id,cube_id,from_node_id,to_node_id,relation,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (from_node_id,to_node_id,relation) DO UPDATE SET metadata=EXCLUDED.metadata RETURNING *`, [randomUUID(), rows.rows[0]!.cube_id, input.fromId, input.toId, input.relation, JSON.stringify(input.metadata ?? {})]);
    return { op: "linked", edge: edgeFromRow(inserted.rows[0]!) };
  }

  private async unlink(scope: Scope, edgeId: string): Promise<MemoryResult> {
    await this.database.query(`DELETE FROM memory_edges e USING memory_cubes c WHERE e.id=$5 AND e.cube_id=c.id AND ${EDITABLE_CUBE}`, [...scopeParams(scope), edgeId]);
    return { op: "unlinked", edgeId };
  }

}
