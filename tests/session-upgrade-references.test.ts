import { describe, expect, it } from "vitest";
import { remapReferences } from "../scripts/session-upgrade/references.js";

describe("离线迁移序号映射", () => {
  const mapping = new Map([[0, 0], [2, 1], [3, 2]]);
  const base = { type: "session/title", seq: 4, time: 5, data: { messageSeqs: [0, 2, 3], title: "原文" } };

  it("重映射标题和来源引用，输入保持不变", () => {
    const event = { ...base, sourceEventSeqs: [2, 3] };
    const original = structuredClone(event);
    expect(remapReferences(event, 3, mapping)).toEqual({ ...event, seq: 3, sourceEventSeqs: [1, 2], data: { ...event.data, messageSeqs: [0, 1, 2] } });
    expect(event).toEqual(original);
  });
  it.each([
    { op: "replace", start: 2, end: 3 },
    { op: "replace", startSeq: 2, endSeq: 3 },
  ])("支持旧版与新版 surface 坐标 %j", (surfaceOp) => {
    const result = remapReferences({ ...base, surfaceOp }, 3, mapping);
    expect(result.surfaceOp).toEqual("startSeq" in surfaceOp ? { op: "replace", startSeq: 1, endSeq: 2 } : { op: "replace", start: 1, end: 2 });
  });
  it.each([1, 4, -1, 0.5, "2"])("拒绝丢失或非法引用 %j", (reference) => {
    expect(() => remapReferences({ ...base, sourceEventSeqs: [reference] }, 3, mapping)).toThrow();
  });
  it("重映射压缩范围和命令源，不修改业务数字", () => {
    expect(remapReferences({ ...base, type: "compaction/prune", data: { shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], count: 2 } }, 3, mapping).data).toEqual({ shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], count: 2 });
    expect(remapReferences({ ...base, type: "command/done", data: { sourceEventSeq: 2, nested: { sourceEventSeq: 2 } } }, 3, mapping).data).toEqual({ sourceEventSeq: 1, nested: { sourceEventSeq: 2 } });
  });
  it("拒绝混合坐标、倒序范围和非先前目标", () => {
    expect(() => remapReferences({ ...base, surfaceOp: { op: "replace", start: 0, end: 2, startSeq: 0, endSeq: 2 } }, 3, mapping)).toThrow("mixed");
    expect(() => remapReferences({ ...base, surfaceOp: { op: "replace", start: 3, end: 2 } }, 3, mapping)).toThrow("reversed");
    expect(() => remapReferences(base, 3, new Map([[0, 0], [2, 1], [3, 3]]))).toThrow("not earlier");
  });
});
