import type {
  CubeId,
  MemoryCommand,
  MemoryCubeInput,
  MemoryEdgeInput,
  MemoryEdgeRelation,
  MemoryModality,
  MemoryNodeInput,
  MemoryNodeKind,
  MemoryNodePatch,
  MemoryPart,
  MemorySource,
  MemoryVisibility,
  MemoryId,
} from "./index.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEMORY_KINDS: readonly MemoryNodeKind[] = ["preference", "fact", "goal", "profile", "episode", "tool_trace", "image", "document", "other"];
const MEMORY_MODALITIES: readonly MemoryModality[] = ["text", "image", "tool_trace", "persona"];
const MEMORY_VISIBILITIES: readonly MemoryVisibility[] = ["user_private", "project_shared", "agent_shared", "deployment_shared", "tenant_shared"];
const MEMORY_RELATIONS: readonly MemoryEdgeRelation[] = ["supports", "contradicts", "derived_from", "related_to", "part_of"];
type RecordValue = Record<string, unknown>;

function recordValue(input: unknown): RecordValue | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as RecordValue : undefined;
}

function nonBlank(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

export function parseMemoryId(input: unknown): MemoryId | undefined {
  return typeof input === "string" && UUID_V4.test(input) ? input as MemoryId : undefined;
}

export function parseCubeId(input: unknown): CubeId | undefined {
  return parseMemoryId(input) as CubeId | undefined;
}

function parseParts(input: unknown): MemoryPart[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const parts: MemoryPart[] = [];
  for (const value of input) {
    const part = recordValue(value);
    if (!part || typeof part.modality !== "string" || !MEMORY_MODALITIES.includes(part.modality as MemoryModality)) return undefined;
    if (part.modality === "text" && nonBlank(part.text)) parts.push({ modality: "text", text: part.text });
    else if (part.modality === "image" && nonBlank(part.uri)) parts.push({ modality: "image", uri: part.uri, ...(typeof part.alt === "string" ? { alt: part.alt } : {}), ...(typeof part.sha256 === "string" ? { sha256: part.sha256 } : {}) });
    else if (part.modality === "tool_trace" && nonBlank(part.tool)) parts.push({ modality: "tool_trace", tool: part.tool, ...(part.input === undefined ? {} : { input: part.input }), ...(part.output === undefined ? {} : { output: part.output }), ...(typeof part.ok === "boolean" ? { ok: part.ok } : {}) });
    else if (part.modality === "persona" && nonBlank(part.trait) && nonBlank(part.value)) parts.push({ modality: "persona", trait: part.trait, value: part.value, ...(typeof part.confidence === "number" ? { confidence: part.confidence } : {}) });
    else return undefined;
  }
  return parts;
}

function parseSource(input: unknown): MemorySource | undefined {
  if (input === undefined) return undefined;
  const source = recordValue(input);
  if (!source || !["conversation", "feedback", "tool", "import", "system"].includes(String(source.kind))) return undefined;
  if (source.reference !== undefined && typeof source.reference !== "string") return undefined;
  return { kind: source.kind as MemorySource["kind"], ...(source.reference === undefined ? {} : { reference: source.reference }) };
}

function parseNodeInput(input: unknown): MemoryNodeInput | undefined {
  const record = recordValue(input);
  if (!record || typeof record.kind !== "string" || !MEMORY_KINDS.includes(record.kind as MemoryNodeKind)) return undefined;
  const parts = parseParts(record.parts);
  if (!parts) return undefined;
  const cube = record.cubeId === undefined ? undefined : parseCubeId(record.cubeId);
  if (record.cubeId !== undefined && !cube) return undefined;
  if (record.confidence !== undefined && (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1)) return undefined;
  const source = parseSource(record.source);
  if (record.source !== undefined && !source) return undefined;
  const metadata = record.metadata === undefined ? undefined : recordValue(record.metadata);
  if (record.metadata !== undefined && !metadata) return undefined;
  return { kind: record.kind as MemoryNodeKind, parts, ...(cube ? { cubeId: cube } : {}), ...(metadata ? { metadata } : {}), ...(typeof record.confidence === "number" ? { confidence: record.confidence } : {}), ...(source ? { source } : {}) };
}

function parseNodePatch(input: unknown): MemoryNodePatch | undefined {
  const record = recordValue(input);
  if (!record) return undefined;
  const result: MemoryNodePatch = {};
  if (record.kind !== undefined && (typeof record.kind !== "string" || !MEMORY_KINDS.includes(record.kind as MemoryNodeKind))) return undefined;
  if (record.parts !== undefined) { const parts = parseParts(record.parts); if (!parts) return undefined; result.parts = parts; }
  if (record.kind !== undefined) result.kind = record.kind as MemoryNodeKind;
  if (record.metadata !== undefined) { const metadata = recordValue(record.metadata); if (!metadata) return undefined; result.metadata = metadata; }
  if (record.confidence !== undefined) { if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) return undefined; result.confidence = record.confidence; }
  if (record.source !== undefined) { const source = parseSource(record.source); if (!source) return undefined; result.source = source; }
  if (record.status !== undefined) { if (record.status !== "active" && record.status !== "archived") return undefined; result.status = record.status; }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseMembers(input: unknown): MemoryCubeInput["members"] | undefined {
  if (!Array.isArray(input)) return undefined;
  const members: NonNullable<MemoryCubeInput["members"]> = [];
  for (const value of input) {
    const member = recordValue(value);
    if (!member || !nonBlank(member.userId) || (member.role !== "editor" && member.role !== "viewer")) return undefined;
    members.push({ userId: member.userId, role: member.role });
  }
  return members;
}

function parseCubeInput(input: unknown): MemoryCubeInput | undefined {
  const record = recordValue(input);
  if (!record || !nonBlank(record.key) || !nonBlank(record.name) || typeof record.visibility !== "string" || !MEMORY_VISIBILITIES.includes(record.visibility as MemoryVisibility)) return undefined;
  const members = record.members === undefined ? undefined : parseMembers(record.members);
  if (record.members !== undefined && !members) return undefined;
  return { key: record.key, name: record.name, visibility: record.visibility as MemoryVisibility, ...(typeof record.projectKey === "string" ? { projectKey: record.projectKey } : {}), ...(typeof record.agentKey === "string" ? { agentKey: record.agentKey } : {}), ...(members ? { members } : {}) };
}

function parseCubePatch(input: unknown): Partial<MemoryCubeInput> | undefined {
  const record = recordValue(input);
  if (!record) return undefined;
  const patch: Partial<MemoryCubeInput> = {};
  for (const key of ["key", "name", "projectKey", "agentKey"] as const) {
    if (record[key] !== undefined) { if (typeof record[key] !== "string" || !record[key].trim()) return undefined; patch[key] = record[key]; }
  }
  if (record.visibility !== undefined) { if (typeof record.visibility !== "string" || !MEMORY_VISIBILITIES.includes(record.visibility as MemoryVisibility)) return undefined; patch.visibility = record.visibility as MemoryVisibility; }
  if (record.members !== undefined) { const members = parseMembers(record.members); if (!members) return undefined; patch.members = members; }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parseEdge(input: unknown): MemoryEdgeInput | undefined {
  const record = recordValue(input);
  const fromId = record && parseMemoryId(record.fromId);
  const toId = record && parseMemoryId(record.toId);
  if (!record || !fromId || !toId || typeof record.relation !== "string" || !MEMORY_RELATIONS.includes(record.relation as MemoryEdgeRelation)) return undefined;
  const metadata = record.metadata === undefined ? undefined : recordValue(record.metadata);
  if (record.metadata !== undefined && !metadata) return undefined;
  return { fromId, toId, relation: record.relation as MemoryEdgeRelation, ...(metadata ? { metadata } : {}) };
}

function expectedRevision(input: unknown): number | undefined | null {
  if (input === undefined) return undefined;
  return typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : null;
}

export type MemoryCommandParseResult = { ok: true; value: MemoryCommand } | { ok: false; error: string };

export function parseMemoryCommand(input: unknown): MemoryCommandParseResult {
  const record = recordValue(input);
  if (!record || typeof record.op !== "string") return { ok: false, error: "command.op is required" };
  const id = parseMemoryId(record.id);
  const cube = parseCubeId(record.cubeId ?? record.id);
  switch (record.op) {
    case "create": { const node = parseNodeInput(record.node); return node ? { ok: true, value: { op: "create", node } } : { ok: false, error: "create.node is invalid" }; }
    case "read": return id && (record.includeEdges === undefined || typeof record.includeEdges === "boolean") ? { ok: true, value: { op: "read", id, ...(record.includeEdges === undefined ? {} : { includeEdges: record.includeEdges }) } } : { ok: false, error: "read.id/includeEdges is invalid" };
    case "update": { const revision = expectedRevision(record.expectedRevision); const patch = parseNodePatch(record.patch); return id && patch && revision !== null ? { ok: true, value: { op: "update", id, patch, ...(revision === undefined ? {} : { expectedRevision: revision }) } } : { ok: false, error: "update.id/patch/revision is invalid" }; }
    case "delete": return id && (record.hard === undefined || typeof record.hard === "boolean") ? { ok: true, value: { op: "delete", id, ...(record.hard === undefined ? {} : { hard: record.hard }) } } : { ok: false, error: "delete.id/hard is invalid" };
    case "search": {
      if (!nonBlank(record.query)) return { ok: false, error: "search.query is required" };
      const limit = record.limit === undefined ? undefined : (typeof record.limit === "number" && Number.isSafeInteger(record.limit) && record.limit > 0 && record.limit <= 50 ? record.limit : null);
      if (limit === null) return { ok: false, error: "search.limit is invalid" };
      const cubeIds = record.cubeIds === undefined ? undefined : Array.isArray(record.cubeIds) ? record.cubeIds.map(parseCubeId) : undefined;
      if (record.cubeIds !== undefined && (!cubeIds || cubeIds.some((value): value is undefined => !value))) return { ok: false, error: "search.cubeIds is invalid" };
      const modalities = record.modalities === undefined ? undefined : Array.isArray(record.modalities) && record.modalities.every((value) => typeof value === "string" && MEMORY_MODALITIES.includes(value as MemoryModality)) ? record.modalities as MemoryModality[] : undefined;
      const kinds = record.kinds === undefined ? undefined : Array.isArray(record.kinds) && record.kinds.every((value) => typeof value === "string" && MEMORY_KINDS.includes(value as MemoryNodeKind)) ? record.kinds as MemoryNodeKind[] : undefined;
      if (record.modalities !== undefined && !modalities || record.kinds !== undefined && !kinds) return { ok: false, error: "search.filters are invalid" };
      return { ok: true, value: { op: "search", query: record.query, ...(limit === undefined ? {} : { limit }), ...(cubeIds ? { cubeIds: cubeIds as CubeId[] } : {}), ...(modalities ? { modalities } : {}), ...(kinds ? { kinds } : {}) } };
    }
    case "link": { const edge = parseEdge(record.edge); return edge ? { ok: true, value: { op: "link", edge } } : { ok: false, error: "link.edge is invalid" }; }
    case "unlink": return id ? { ok: true, value: { op: "unlink", edgeId: id } } : { ok: false, error: "unlink.edgeId is invalid" };
    case "cube_create": { const cubeInput = parseCubeInput(record.cube); return cubeInput ? { ok: true, value: { op: "cube_create", cube: cubeInput } } : { ok: false, error: "cube_create.cube is invalid" }; }
    case "cube_read": return cube ? { ok: true, value: { op: "cube_read", id: cube } } : { ok: false, error: "cube_read.id is invalid" };
    case "cube_update": { const revision = expectedRevision(record.expectedRevision); const patch = parseCubePatch(record.patch); return cube && patch && revision !== null ? { ok: true, value: { op: "cube_update", id: cube, patch, ...(revision === undefined ? {} : { expectedRevision: revision }) } } : { ok: false, error: "cube_update.id/patch/revision is invalid" }; }
    case "cube_delete": return cube ? { ok: true, value: { op: "cube_delete", id: cube } } : { ok: false, error: "cube_delete.id is invalid" };
    case "cube_list": return { ok: true, value: { op: "cube_list" } };
    case "compose": { if (!Array.isArray(record.cubeIds) || record.cubeIds.length === 0 || record.cubeIds.length > 32) return { ok: false, error: "compose.cubeIds is invalid" }; const cubeIds = record.cubeIds.map(parseCubeId); return cubeIds.some((value): value is undefined => !value) ? { ok: false, error: "compose.cubeIds is invalid" } : { ok: true, value: { op: "compose", cubeIds: cubeIds as CubeId[], ...(typeof record.name === "string" && record.name.trim() ? { name: record.name.trim() } : {}) } }; }
    case "feedback": return nonBlank(record.instruction) && (record.cubeId === undefined || cube) ? { ok: true, value: { op: "feedback", instruction: record.instruction, ...(cube ? { cubeId: cube } : {}) } } : { ok: false, error: "feedback.instruction/cubeId is invalid" };
    default: return { ok: false, error: "unsupported memory operation" };
  }
}
