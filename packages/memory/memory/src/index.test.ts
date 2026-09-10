import { describe, expect, it } from "vitest";

import { parseMemoryCommand } from "./index.js";

const memoryId = "00000000-0000-4000-8000-000000000001";
const cubeId = "00000000-0000-4000-8000-000000000002";

describe("parseMemoryCommand", () => {
  it("解析多模态节点和带过滤条件的搜索", () => {
    expect(parseMemoryCommand({
      op: "create",
      node: {
        kind: "tool_trace",
        cubeId,
        parts: [{ modality: "tool_trace", tool: "shell", input: { command: "pwd" }, ok: true }],
      },
    })).toMatchObject({ ok: true, value: { op: "create", node: { cubeId, kind: "tool_trace" } } });
    expect(parseMemoryCommand({ op: "search", query: "shell", limit: 5, cubeIds: [cubeId], modalities: ["tool_trace"] })).toMatchObject({ ok: true });
  });

  it("拒绝不完整的增删改和空组合", () => {
    expect(parseMemoryCommand({ op: "create", node: { kind: "fact", parts: [] } })).toMatchObject({ ok: false });
    expect(parseMemoryCommand({ op: "update", id: memoryId, patch: {}, expectedRevision: 0 })).toMatchObject({ ok: false });
    expect(parseMemoryCommand({ op: "compose", cubeIds: [] })).toMatchObject({ ok: false });
    expect(parseMemoryCommand({ op: "unlink", edgeId: "not-a-uuid" })).toMatchObject({ ok: false });
  });

  it("保留反馈、Cube 更新和关系命令的结构化类型", () => {
    expect(parseMemoryCommand({ op: "feedback", instruction: "更正称呼为小王", cubeId })).toMatchObject({ ok: true, value: { op: "feedback", cubeId } });
    expect(parseMemoryCommand({ op: "cube_update", id: cubeId, patch: { name: "项目记忆" }, expectedRevision: 1 })).toMatchObject({ ok: true });
    expect(parseMemoryCommand({ op: "link", edge: { fromId: memoryId, toId: cubeId, relation: "related_to" } })).toMatchObject({ ok: true });
  });
});
