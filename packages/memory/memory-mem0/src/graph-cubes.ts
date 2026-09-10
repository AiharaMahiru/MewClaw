import { randomUUID } from "node:crypto";

import type { Scope } from "dsh-lark-contracts";
import { parseCubeId, type MemoryCommand, type MemoryCube, type MemoryCubeInput, type MemoryNodeInput, type MemoryNodePatch, type MemoryResult } from "dsh-memory";

import { ACCESSIBLE_CUBE, EDITABLE_CUBE } from "./acl.js";
import { searchableText } from "./content.js";
import type { MemoryDatabase, MemoryQueryExecutor } from "./database.js";
import { cubeId, memoryScopeIds, memoryUserKey } from "./identifiers.js";
import { cubeFromRow, type CubeRow, scopeParams, type Mem0ClientPort, type LoggerPort } from "./graph-types.js";

type SearchResult = Extract<MemoryResult, { op: "search" }>;

/** Cube、ACL 关系和自然语言反馈的共享实现；节点 CRUD 保留在主图存储。 */
export abstract class MemoryCubeStore {
  protected constructor(
    protected readonly database: MemoryDatabase,
    protected readonly mem0: Mem0ClientPort | undefined,
    protected readonly logger: LoggerPort,
  ) {}

  protected abstract createNode(scope: Scope, input: MemoryNodeInput): Promise<MemoryResult>;
  protected abstract searchNodes(scope: Scope, command: Extract<MemoryCommand, { op: "search" }>): Promise<SearchResult>;
  protected abstract updateNode(scope: Scope, id: string, patch: MemoryNodePatch, expectedRevision?: number): Promise<MemoryResult>;
  protected abstract deleteNode(scope: Scope, id: string, hard: boolean): Promise<MemoryResult>;

  async feedback(scope: Scope, instruction: string, cube?: MemoryCube["id"]): Promise<MemoryResult> {
    return this.applyFeedback(scope, instruction, cube);
  }

  protected async createCube(scope: Scope, input: MemoryCubeInput): Promise<MemoryResult> {
    validateCube(input);
    const id = randomUUID();
    const row = await this.database.transaction(async (tx) => {
      const inserted = await tx.query<CubeRow>(
        `INSERT INTO memory_cubes (id,tenant_id,bot_id,deployment_id,owner_user_id,cube_key,name,visibility,project_key,agent_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, ...scopeParams(scope), input.key, input.name, input.visibility, input.projectKey ?? null, input.agentKey ?? null],
      );
      const ownerKey = memoryScopeIds(scope).userId;
      await tx.query(`INSERT INTO memory_cube_members (cube_id,user_id,role) VALUES ($1,$2,'owner')`, [id, ownerKey]);
      for (const member of input.members ?? []) {
        await tx.query(
          `INSERT INTO memory_cube_members (cube_id,user_id,role) VALUES ($1,$2,$3)
           ON CONFLICT (cube_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
          [id, memoryUserKey(scope, member.userId), member.role],
        );
      }
      return inserted.rows[0]!;
    });
    return { op: "cube_created", cube: cubeFromRow(row) };
  }

  protected async listCubes(scope: Scope): Promise<MemoryResult> {
    const rows = await this.database.query<CubeRow>(`SELECT c.* FROM memory_cubes c WHERE ${ACCESSIBLE_CUBE} ORDER BY c.updated_at DESC`, scopeParams(scope));
    return { op: "cube_list", cubes: rows.rows.map(cubeFromRow) };
  }

  protected async readCube(scope: Scope, id: string): Promise<MemoryResult> {
    const rows = await this.database.query<CubeRow>(`SELECT c.* FROM memory_cubes c WHERE c.id=$5 AND ${ACCESSIBLE_CUBE}`, [...scopeParams(scope), id]);
    return { op: "cube_read", ...(rows.rows[0] ? { cube: cubeFromRow(rows.rows[0]) } : {}) };
  }

  protected async ensureDefaultCube(scope: Scope, tx: MemoryQueryExecutor): Promise<string> {
    const key = `user:${memoryScopeIds(scope).userId}`;
    const existing = await tx.query<{ id: string }>(`SELECT id FROM memory_cubes WHERE tenant_id=$1 AND bot_id=$2 AND deployment_id=$3 AND cube_key=$4`, [scope.tenantId, scope.botId, scope.deploymentId, key]);
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    await tx.query(`INSERT INTO memory_cubes (id,tenant_id,bot_id,deployment_id,owner_user_id,cube_key,name,visibility) VALUES ($1,$2,$3,$4,$5,$6,$7,'user_private')`, [id, ...scopeParams(scope), key, "个人记忆"]);
    await tx.query(`INSERT INTO memory_cube_members (cube_id,user_id,role) VALUES ($1,$2,'owner')`, [id, memoryScopeIds(scope).userId]);
    return id;
  }

  protected async updateCube(scope: Scope, id: string, patch: Partial<MemoryCubeInput>, expectedRevision?: number): Promise<MemoryResult> {
    validateCubePatch(patch);
    const row = await this.database.query<CubeRow>(`SELECT c.* FROM memory_cubes c WHERE c.id=$5 AND ${EDITABLE_CUBE}`, [...scopeParams(scope), id]);
    if (!row.rows[0]) throw new Error("MEMORY_CUBE_NOT_FOUND");
    if (expectedRevision !== undefined && row.rows[0].revision !== expectedRevision) throw new Error("MEMORY_REVISION_CONFLICT");
    const updated = await this.database.query<CubeRow>(
      `UPDATE memory_cubes c SET cube_key=COALESCE($5,c.cube_key),name=COALESCE($6,c.name),visibility=COALESCE($7,c.visibility),project_key=COALESCE($8,c.project_key),agent_key=COALESCE($9,c.agent_key),revision=c.revision+1,updated_at=now()
       WHERE c.id=$10 AND ${EDITABLE_CUBE} RETURNING c.*`,
      [...scopeParams(scope), patch.key ?? null, patch.name ?? null, patch.visibility ?? null, patch.projectKey ?? null, patch.agentKey ?? null, id],
    );
    if (patch.members) {
      for (const member of patch.members) {
        await this.database.query(
          `INSERT INTO memory_cube_members (cube_id,user_id,role) VALUES ($1,$2,$3)
           ON CONFLICT (cube_id,user_id) DO UPDATE SET role=EXCLUDED.role`,
          [id, memoryUserKey(scope, member.userId), member.role],
        );
      }
    }
    return { op: "cube_updated", cube: cubeFromRow(updated.rows[0]!) };
  }

  protected async deleteCube(scope: Scope, id: string): Promise<MemoryResult> {
    const cube = await this.database.query<{ id: string }>(`SELECT c.id FROM memory_cubes c WHERE c.id=$5 AND c.owner_user_id=$4 AND ${EDITABLE_CUBE}`, [...scopeParams(scope), id]);
    if (!cube.rows[0]) throw new Error("MEMORY_CUBE_NOT_FOUND");
    const nodes = await this.database.query<{ mem0_id: string | null }>(`SELECT n.mem0_id FROM memory_nodes n JOIN memory_cubes c ON c.id=n.cube_id WHERE c.id=$5 AND ${EDITABLE_CUBE}`, [...scopeParams(scope), id]);
    await this.database.query(`DELETE FROM memory_cubes c WHERE c.id=$5 AND c.owner_user_id=$4 AND c.tenant_id=$1 AND c.bot_id=$2 AND c.deployment_id=$3`, [...scopeParams(scope), id]);
    if (this.mem0?.delete) {
      for (const node of nodes.rows) {
        if (node.mem0_id) void this.mem0.delete(node.mem0_id).catch((error) => this.logger.warn(`memory-mem0: cube index delete failed (${error instanceof Error ? error.message : "unknown"})`));
      }
    }
    return { op: "cube_deleted", id: cubeId(id) };
  }

  protected async compose(scope: Scope, ids: MemoryCube["id"][]): Promise<MemoryResult> {
    if (ids.length === 0 || ids.length > 32) throw new Error("MEMORY_CUBE_INVALID");
    const listed = await this.listCubes(scope);
    if (listed.op !== "cube_list") return { op: "composed", cubes: [] };
    const byId = new Map(listed.cubes.map((cube) => [cube.id, cube]));
    const cubes = ids.map((id) => byId.get(id)).filter((cube): cube is MemoryCube => Boolean(cube));
    if (cubes.length !== ids.length) throw new Error("MEMORY_CUBE_NOT_FOUND");
    return { op: "composed", cubes };
  }

  private async applyFeedback(scope: Scope, instruction: string, cube?: MemoryCube["id"]): Promise<MemoryResult> {
    const text = instruction.trim();
    if (!text) throw new Error("MEMORY_FEEDBACK_EMPTY");
    if (cube && !parseCubeId(cube)) throw new Error("MEMORY_CUBE_INVALID");
    const correction = parseCorrection(text);
    const query = (correction?.target ?? text.replace(/^(请)?\s*(记住|补充|更正|纠正|把|忘记|删除|不要记住|forget|delete)\s*/iu, "")).slice(0, 2_000);
    const hits = await this.searchNodes(scope, { op: "search", query, ...(cube ? { cubeIds: [cube] } : {}), limit: 3 });
    // Mem0 可能返回多个语义近邻；若词法目标唯一，优先使用它避免反馈被无谓排队。
    const lexicalHits = hits.nodes.filter((node) => searchableText(node.parts).toLowerCase().includes(query.toLowerCase()));
    const hit = lexicalHits.length === 1 ? lexicalHits[0] : hits.nodes.length === 1 ? hits.nodes[0] : undefined;
    const forgetting = /忘记|删除|不要记住|forget|delete/i.test(text);
    if (forgetting && hit) {
      await this.deleteNode(scope, hit.id, false);
      return { op: "feedback", result: "deleted" };
    }
    if (correction && hit) {
      const updated = await this.updateNode(scope, hit.id, { parts: [{ modality: "text", text: correction.replacement }], kind: hit.kind }, hit.revision);
      return updated.op === "updated" ? { op: "feedback", result: "updated", node: updated.node } : { op: "feedback", result: "updated" };
    }
    if (forgetting || correction) return { op: "feedback", result: "queued" };
    const created = await this.createNode(scope, { ...(cube ? { cubeId: cube } : {}), kind: "fact", parts: [{ modality: "text", text }], source: { kind: "feedback" } });
    return created.op === "created" ? { op: "feedback", result: "created", node: created.node } : { op: "feedback", result: "created" };
  }
}

function validateCube(input: MemoryCubeInput): void {
  if (!input.key.trim() || input.key.length > 128 || !input.name.trim() || input.name.length > 256) throw new Error("MEMORY_CUBE_INVALID");
  if (!["user_private", "project_shared", "agent_shared", "deployment_shared", "tenant_shared"].includes(input.visibility)) throw new Error("MEMORY_CUBE_INVALID");
  if (input.members?.some((member) => !member.userId.trim() || !["editor", "viewer"].includes(member.role))) throw new Error("MEMORY_CUBE_INVALID");
}

function validateCubePatch(patch: Partial<MemoryCubeInput>): void {
  if (patch.key !== undefined && (!patch.key.trim() || patch.key.length > 128)) throw new Error("MEMORY_CUBE_INVALID");
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 256)) throw new Error("MEMORY_CUBE_INVALID");
  if (patch.members?.some((member) => !member.userId.trim() || !["editor", "viewer"].includes(member.role))) throw new Error("MEMORY_CUBE_INVALID");
}

interface Correction { target: string; replacement: string }

function parseCorrection(text: string): Correction | undefined {
  const patterns = [
    /(?:更正|纠正|修正)\s*(.+?)\s*(?:改成|改为|替换为|为|是|，|,)\s*(.+)$/u,
    /把\s*(.+?)\s*(?:改成|改为|替换为)\s*(.+)$/u,
    /(.+?)\s*不是\s*(.+?)\s*而是\s*(.+)$/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const target = (match[1] ?? "").trim();
    const replacement = (match[3] ?? match[2] ?? "").trim();
    if (target && replacement) return { target, replacement };
  }
  return undefined;
}
