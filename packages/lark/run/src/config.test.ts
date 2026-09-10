import { describe, expect, it } from "vitest";

import { resolveRunConfig } from "./config.js";

describe("lark-run 配置", () => {
  it("飞书 bot 模板与 DSH agent preset 使用独立配置", () => {
    const defaults = resolveRunConfig({ presetId: "lark-standard" });
    expect(defaults.presetId).toBe("lark-standard");
    expect(defaults.agentPresetId).toBe("standard");

    const explicit = resolveRunConfig({ presetId: "knowledge-assistant", agentPresetId: "code" });
    expect(explicit.presetId).toBe("knowledge-assistant");
    expect(explicit.agentPresetId).toBe("code");
  });

  it("拒绝无 token 的非 loopback 监听", () => {
    expect(() => resolveRunConfig({
      host: "0.0.0.0",
      presetId: "lark-standard",
    })).toThrow("0.0.0.0 监听必须配置 tokenEnv");
  });

  it("兼容旧的统一无进展超时，且 profile 配置优先", () => {
    expect(resolveRunConfig({ presetId: "lark-standard", runTimeoutMs: 12_000 }).profileTimeouts).toEqual({
      quick: 12_000,
      standard: 12_000,
      long: 12_000,
    });
    expect(resolveRunConfig({
      presetId: "lark-standard",
      runTimeoutMs: 12_000,
      profileTimeouts: { quick: 1_000, standard: 2_000, long: 3_000 },
    }).profileTimeouts).toEqual({ quick: 1_000, standard: 2_000, long: 3_000 });
  });

  it("在启动前拒绝会破坏监听、计时器或队列的不合法数值", () => {
    const invalidConfigs = [
      { port: -1 },
      { port: 65_536 },
      { runTimeoutMs: 0 },
      { runHardTimeoutMs: -1 },
      { profileTimeouts: { quick: 0, standard: 1, long: 1 } },
      { concurrency: { maxRuns: 0, maxRunsPerUser: 1, maxQueuedPerScope: 1 } },
      { heartbeatIntervalMs: 0 },
      { agentPresetId: "" },
    ];
    for (const config of invalidConfigs) {
      expect(() => resolveRunConfig({ presetId: "lark-standard", ...config })).toThrow("lark-run:");
    }
  });
});
