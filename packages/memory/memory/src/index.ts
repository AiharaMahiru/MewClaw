/**
 * dsh-memory Definition（SPEC memory.md）。
 *
 * `execute` 是统一的图记忆 API；`recall`/`remember` 只为既有执行器保留。
 * Provider 必须在每个查询和写入中落实完整 Scope ACL，不能把 nodeId 或
 * cubeId 当作授权证据。
 */
import "@deepseek-ai/cordis";

import type { Scope } from "dsh-lark-contracts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    /** 跨会话记忆能力缝（Provider 可降级为 no-op）。 */
    memory?: MemoryService;
  }
}

declare const memoryIdBrand: unique symbol;
declare const cubeIdBrand: unique symbol;
export type MemoryId = string & { readonly [memoryIdBrand]: true };
export type CubeId = string & { readonly [cubeIdBrand]: true };

export type MemoryVisibility =
  | "user_private"
  | "project_shared"
  | "agent_shared"
  | "deployment_shared"
  | "tenant_shared";

export type MemoryNodeKind =
  | "preference"
  | "fact"
  | "goal"
  | "profile"
  | "episode"
  | "tool_trace"
  | "image"
  | "document"
  | "other";

export type MemoryModality = "text" | "image" | "tool_trace" | "persona";

export type MemoryPart =
  | { modality: "text"; text: string }
  | { modality: "image"; uri: string; alt?: string; sha256?: string }
  | {
      modality: "tool_trace";
      tool: string;
      input?: unknown;
      output?: unknown;
      ok?: boolean;
    }
  | { modality: "persona"; trait: string; value: string; confidence?: number };

export interface MemorySource {
  kind: "conversation" | "feedback" | "tool" | "import" | "system";
  reference?: string;
}

export interface MemoryNodeInput {
  cubeId?: CubeId;
  kind: MemoryNodeKind;
  parts: MemoryPart[];
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: MemorySource;
}

export interface MemoryNodePatch {
  kind?: MemoryNodeKind;
  parts?: MemoryPart[];
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: MemorySource;
  status?: "active" | "archived";
}

export interface MemoryNode extends MemoryNodeInput {
  id: MemoryId;
  cubeId: CubeId;
  revision: number;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type MemoryEdgeRelation =
  | "supports"
  | "contradicts"
  | "derived_from"
  | "related_to"
  | "part_of";

export interface MemoryEdgeInput {
  fromId: MemoryId;
  toId: MemoryId;
  relation: MemoryEdgeRelation;
  metadata?: Record<string, unknown>;
}

export interface MemoryEdge extends MemoryEdgeInput {
  id: string;
  cubeId: CubeId;
  createdAt: string;
}

export interface MemoryCubeInput {
  key: string;
  name: string;
  visibility: MemoryVisibility;
  projectKey?: string;
  agentKey?: string;
  members?: Array<{ userId: string; role: "editor" | "viewer" }>;
}

export interface MemoryCube extends MemoryCubeInput {
  id: CubeId;
  ownerUserId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryCommand =
  | { op: "create"; node: MemoryNodeInput }
  | { op: "read"; id: MemoryId; includeEdges?: boolean }
  | { op: "update"; id: MemoryId; patch: MemoryNodePatch; expectedRevision?: number }
  | { op: "delete"; id: MemoryId; hard?: boolean }
  | { op: "search"; query: string; cubeIds?: CubeId[]; limit?: number; modalities?: MemoryModality[]; kinds?: MemoryNodeKind[] }
  | { op: "link"; edge: MemoryEdgeInput }
  | { op: "unlink"; edgeId: string }
  | { op: "cube_create"; cube: MemoryCubeInput }
  | { op: "cube_read"; id: CubeId }
  | { op: "cube_update"; id: CubeId; patch: Partial<MemoryCubeInput>; expectedRevision?: number }
  | { op: "cube_delete"; id: CubeId }
  | { op: "cube_list" }
  | { op: "compose"; cubeIds: CubeId[]; name?: string }
  | { op: "feedback"; instruction: string; cubeId?: CubeId };

export type MemoryResult =
  | { op: "created"; node: MemoryNode }
  | { op: "read"; node?: MemoryNode; edges: MemoryEdge[] }
  | { op: "updated"; node: MemoryNode }
  | { op: "deleted"; id: MemoryId; hard: boolean }
  | { op: "search"; nodes: MemoryNode[]; edges: MemoryEdge[] }
  | { op: "linked"; edge: MemoryEdge }
  | { op: "unlinked"; edgeId: string }
  | { op: "cube_created"; cube: MemoryCube }
  | { op: "cube_read"; cube?: MemoryCube }
  | { op: "cube_updated"; cube: MemoryCube }
  | { op: "cube_deleted"; id: CubeId }
  | { op: "cube_list"; cubes: MemoryCube[] }
  | { op: "composed"; cubes: MemoryCube[] }
  | { op: "feedback"; result: "created" | "updated" | "deleted" | "queued"; node?: MemoryNode };

/** 记忆召回命中；文本是模型不可信上下文。 */
export interface MemoryHit {
  content: string;
  rank: number;
  nodeId?: MemoryId;
  cubeId?: CubeId;
  score?: number;
  modality?: MemoryModality;
}

/** 执行器写入时携带的多模态上下文。 */
export interface MemoryCapture {
  cubeId?: CubeId;
  kind?: MemoryNodeKind;
  parts?: MemoryPart[];
  metadata?: Record<string, unknown>;
  source?: MemorySource;
}

export interface MemoryService {
  /** 统一图 API：所有增删改查和 Cube 操作都从此入口进入。 */
  execute(scope: Scope, command: MemoryCommand): Promise<MemoryResult>;
  /** 兼容执行器：检索相关记忆并返回不可信命中。 */
  recall(scope: Scope, query: string): Promise<MemoryHit[]>;
  /** 兼容执行器：异步写入一次交互记忆。 */
  remember(scope: Scope, userText: string, assistantText: string, capture?: MemoryCapture): Promise<void>;
  /** 自然语言反馈：纠正、补充、替换或遗忘已有记忆。 */
  feedback(scope: Scope, instruction: string, cubeId?: CubeId): Promise<MemoryResult>;
  /** 是否启用（false = no-op 降级）。 */
  enabled(): boolean;
}

export { parseCubeId, parseMemoryCommand, parseMemoryId } from "./parser.js";
export type { MemoryCommandParseResult } from "./parser.js";
