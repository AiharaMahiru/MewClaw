/**
 * 错误分类学测试（SPEC contracts.md §4.4/§8）。
 */
import { describe, expect, it } from "vitest";

import { LarkError, toWire } from "./errors.js";

describe("toWire", () => {
  it("LarkError 原样传输 code 与 message", () => {
    const error = new LarkError("QUEUE_FULL", "user-visible", "队列已满");
    expect(toWire(error)).toEqual({ code: "QUEUE_FULL", message: "队列已满" });
  });

  it("未知异常规约为 RUNTIME_ERROR 且脱敏", () => {
    expect(toWire(new TypeError("provider internal detail"))).toEqual({
      code: "RUNTIME_ERROR",
      message: "unexpected TypeError",
    });
    expect(toWire("plain string")).toEqual({ code: "RUNTIME_ERROR", message: "unexpected unknown" });
  });
});
