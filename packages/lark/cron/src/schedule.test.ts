/**
 * 调度解析测试（lark-claw schedule.test 案例平移 + endAt 边界）。
 */
import { describe, expect, it } from "vitest";

import { parseOneTimeInstant, validateSchedule } from "dsh-lark-contracts";
import { nextOccurrence } from "./schedule.js";

describe("parseOneTimeInstant", () => {
  it("合法 ISO 时刻解析；非法拒绝", () => {
    expect(parseOneTimeInstant("2026-08-20T09:00:00Z").getTime()).toBe(Date.parse("2026-08-20T09:00:00Z"));
    expect(() => parseOneTimeInstant("2026-02-30T09:00:00Z")).toThrow(/非法/);
    expect(() => parseOneTimeInstant("2026-08-20 09:00:00")).toThrow(/非法/);
    expect(() => parseOneTimeInstant("2026-08-20T09:00:00+25:00")).toThrow(/非法/);
  });
});

describe("nextOccurrence", () => {
  it("一次性时刻：过期返回 undefined，未来返回时刻", () => {
    const after = new Date("2026-08-20T00:00:00Z");
    expect(nextOccurrence({ kind: "at", at: "2026-08-19T23:00:00Z" }, after)).toBeUndefined();
    expect(nextOccurrence({ kind: "at", at: "2026-08-20T09:00:00Z" }, after)?.toISOString())
      .toBe("2026-08-20T09:00:00.000Z");
  });

  it("五字段 cron：下一时刻（时区语义）；endAt 含端点", () => {
    const after = new Date("2026-08-20T00:00:00Z");
    const next = nextOccurrence({ kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" }, after);
    expect(next?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
    // endAt = 当天 08:00 → 下一时刻越过边界 → undefined。
    expect(nextOccurrence({
      kind: "cron",
      expression: "0 9 * * 1-5",
      timezone: "UTC",
      endAt: "2026-08-20T08:00:00Z",
    }, after)).toBeUndefined();
  });

  it("非法表达式/时区拒绝", () => {
    expect(() => nextOccurrence({ kind: "cron", expression: "bad expr", timezone: "UTC" }, new Date()))
      .toThrow(/非法/);
    expect(() => validateSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Not/AZone" }))
      .toThrow(/非法/);
    expect(() => validateSchedule({ kind: "cron", expression: "0 9 * * 1-5", timezone: "" }))
      .toThrow(/时区/);
  });
});
