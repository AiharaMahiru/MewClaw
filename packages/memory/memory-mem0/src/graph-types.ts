import type { Scope } from "dsh-lark-contracts";
import type { MemoryCube, MemoryEdge, MemoryNode } from "dsh-memory";

import { cubeId, memoryId, memoryScopeIds } from "./identifiers.js";

export interface Mem0Result {
  id?: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface Mem0ClientPort {
  search(query: string, options: { filters: Record<string, string>; topK: number }): Promise<{ results: Mem0Result[] }>;
  add(messages: Array<{ role: string; content: string }>, options: {
    userId: string;
    agentId: string;
    metadata: Record<string, string>;
    infer: boolean;
  }): Promise<Array<{ id?: string }> | { results?: Array<{ id?: string }> }>;
  update?(id: string, input: { text: string; metadata?: Record<string, string> }): Promise<unknown>;
  delete?(id: string): Promise<unknown>;
}

export interface LoggerPort { warn(message: string): void }

export interface CubeRow {
  id: string; tenant_id: string; bot_id: string; deployment_id: string; owner_user_id: string;
  cube_key: string; name: string; visibility: MemoryCube["visibility"];
  project_key: string | null; agent_key: string | null; revision: number; created_at: Date | string; updated_at: Date | string;
}

export interface NodeRow {
  id: string; cube_id: string; kind: MemoryNode["kind"]; modality: MemoryNode["parts"][number]["modality"]; mem0_id: string | null;
  parts: MemoryNode["parts"]; metadata: Record<string, unknown>; confidence: number | null; source: MemoryNode["source"];
  status: MemoryNode["status"]; revision: number; created_at: Date | string; updated_at: Date | string;
}

export interface EdgeRow {
  id: string; cube_id: string; from_node_id: string; to_node_id: string;
  relation: MemoryEdge["relation"]; metadata: Record<string, unknown>; created_at: Date | string;
}

export function scopeParams(scope: Scope): string[] {
  return [scope.tenantId, scope.botId, scope.deploymentId, memoryScopeIds(scope).userId];
}

export function cubeFromRow(row: CubeRow): MemoryCube {
  return {
    id: cubeId(row.id), key: row.cube_key, name: row.name, visibility: row.visibility,
    ...(row.project_key ? { projectKey: row.project_key } : {}),
    ...(row.agent_key ? { agentKey: row.agent_key } : {}), ownerUserId: row.owner_user_id,
    revision: row.revision, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export function nodeFromRow(row: NodeRow): MemoryNode {
  return {
    id: memoryId(row.id), cubeId: cubeId(row.cube_id), kind: row.kind, parts: row.parts,
    ...(row.metadata ? { metadata: row.metadata } : {}), ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.source ? { source: row.source } : {}), revision: row.revision, status: row.status,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

export function edgeFromRow(row: EdgeRow): MemoryEdge {
  return { id: row.id, cubeId: cubeId(row.cube_id), fromId: memoryId(row.from_node_id), toId: memoryId(row.to_node_id), relation: row.relation, metadata: row.metadata, createdAt: iso(row.created_at) };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
