/**
 * ids 解析测试：全部拒绝用例（SPEC contracts.md §8）。
 */
import { describe, expect, it } from "vitest";

import { parseArtifactId, parseJobId, parseRunId, parseTenantId } from "./ids.js";

describe("parse* ID 校验", () => {
  it("接受合法字符串并 trim", () => {
    const result = parseTenantId("  tenant-a  ");
    expect(result).toEqual({ ok: true, value: "tenant-a" });
  });

  it("拒绝非字符串", () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      const result = parseTenantId(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("拒绝空串与纯空白", () => {
    for (const value of ["", "   ", "\t\n"]) {
      expect(parseTenantId(value).ok).toBe(false);
    }
  });

  it("拒绝超长（>256 字符）", () => {
    expect(parseTenantId("a".repeat(257)).ok).toBe(false);
    expect(parseTenantId("a".repeat(256)).ok).toBe(true);
  });

  it("拒绝控制字符（含换行，防日志/NDJSON 注入）", () => {
    for (const value of ["a\u0000b", "a\nb", "a\rb", "a\u001fb", "a\u007fb"]) {
      expect(parseRunId(value).ok).toBe(false);
    }
  });

  it("parseJobId 只接受小写十六进制 UUID", () => {
    const uuid = "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9c";
    expect(parseJobId(uuid)).toEqual({ ok: true, value: uuid });
    for (const value of ["", "not-a-uuid", uuid.toUpperCase(), `${uuid}extra`, "0195d3a8-6e2c-7f0a-9b1d-4c5e6f7a8b9"]) {
      expect(parseJobId(value).ok).toBe(false);
    }
  });

  it("parseArtifactId 走通用 ID 校验", () => {
    expect(parseArtifactId("artifact-1").ok).toBe(true);
    expect(parseArtifactId("").ok).toBe(false);
  });
});
