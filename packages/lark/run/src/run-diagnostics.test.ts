import { describe, expect, it, vi } from "vitest";

import { atRunStage, atRunStageSync } from "./run-diagnostics.js";

describe("run stage diagnostics", () => {
  it("reports successful async stages without changing the result", async () => {
    const report = vi.fn();

    await expect(atRunStage("agent-idle", async () => "ready", report)).resolves.toBe("ready");
    expect(report).toHaveBeenCalledWith("agent-idle", expect.any(Number), "ok");
  });

  it("reports failed async stages and preserves the stage error", async () => {
    const report = vi.fn();

    await expect(
      atRunStage("prompt-prepare", async () => {
        throw new Error("attachment failed");
      }, report),
    ).rejects.toMatchObject({ name: "RunStageError", stage: "prompt-prepare" });
    expect(report).toHaveBeenCalledWith("prompt-prepare", expect.any(Number), "failed");
  });

  it("does not let a diagnostic reporter break a synchronous stage", () => {
    const report = () => {
      throw new Error("logger unavailable");
    };

    expect(atRunStageSync("session-input", () => 1, report)).toBe(1);
  });
});
