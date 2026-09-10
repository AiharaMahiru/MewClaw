/**
 * dsh-tool-cron 测试：调度归一化（ISO/cron/默认时区）、创建调用
 * （Scope 取自运行信封）、无 Scope fail loud。
 */
import { describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

import { apply, formatCronOutput, normalizeSchedule } from "./index.js";

describe("normalizeSchedule", () => {
  it("ISO 时刻 → at；cron → 表达式 + 缺省时区", () => {
    expect(normalizeSchedule({ schedule: "2026-08-20T09:00:00Z", task: "t" }))
      .toEqual({ kind: "at", at: "2026-08-20T09:00:00Z" });
    expect(normalizeSchedule({ schedule: "0 9 * * 1-5", task: "t" }))
      .toEqual({ kind: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" });
  });

  it("非法输入 fail loud", () => {
    expect(() => normalizeSchedule({ schedule: "not cron", task: "t" })).toThrow(/非法/);
    expect(() => normalizeSchedule({ schedule: "2026-08-20T09:00:00Z", timezone: "UTC", task: "t" }))
      .toThrow(/一次性/);
  });
});

describe("dsh-tool-cron 工具", () => {
  it("执行：Scope 取自运行信封 → ctx.cron.create", async () => {
    const definitions: ToolDefinition[] = [];
    const create = vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      task: "每天总结",
      status: "active",
      nextRunAt: "2026-08-21T09:00:00.000+08:00",
    }));
    const ctx = {
      cron: { create },
      larkScopeIndex: { get: vi.fn(() => ({ tenantId: "t", botId: "b", deploymentId: "d", userId: "ou_1", conversationId: "oc_1" })) },
      systemPrompt: { section: vi.fn() },
      tools: { register: vi.fn((definition: ToolDefinition) => { definitions.push(definition); }) },
    };
    apply(ctx as never, {});

    const tool = definitions[0]!;
    const result = await tool.execute(
      { schedule: "0 9 * * 1-5", task: "每天总结", timezone: "UTC" },
      { agent: { id: "s1" } } as never,
    );
    expect(create).toHaveBeenCalledWith(expect.anything(), {
      task: "每天总结",
      schedule: { kind: "cron", expression: "0 9 * * 1-5", timezone: "UTC" },
    });
    expect(result).toEqual({
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        task: "每天总结",
        status: "active",
        nextRunAt: "2026-08-21T09:00:00.000+08:00",
      },
    });
  });

  it("无 Scope / 无 agent fail loud；enabled=false 不注册", async () => {
    const definitions: ToolDefinition[] = [];
    const ctx = {
      cron: { create: vi.fn() },
      larkScopeIndex: { get: vi.fn(() => undefined) },
      systemPrompt: { section: vi.fn() },
      tools: { register: vi.fn((definition: ToolDefinition) => { definitions.push(definition); }) },
    };
    apply(ctx as never, {});
    await expect(definitions[0]!.execute({ schedule: "2026-08-20T09:00:00Z", task: "t" }, { agent: { id: "s1" } } as never))
      .rejects.toThrow(/lark run scope/);

    const noAgent: ToolDefinition[] = [];
    const ctx2 = {
      cron: { create: vi.fn() },
      larkScopeIndex: { get: vi.fn(() => ({})) },
      systemPrompt: { section: vi.fn() },
      tools: { register: vi.fn((definition: ToolDefinition) => { noAgent.push(definition); }) },
    };
    apply(ctx2 as never, {});
    await expect(noAgent[0]!.execute({ schedule: "2026-08-20T09:00:00Z", task: "t" }, {} as never))
      .rejects.toThrow(/agent context/);

    const disabled: ToolDefinition[] = [];
    apply({ systemPrompt: { section: vi.fn() }, tools: { register: vi.fn((d: ToolDefinition) => { disabled.push(d); }) } } as never, { enabled: false });
    expect(disabled).toHaveLength(0);
  });

  it("formatCronOutput", () => {
    expect(formatCronOutput(undefined)).toContain("no job");
    expect(formatCronOutput({ job: { id: "j1", task: "t", status: "active", nextRunAt: "x" } })).toContain("j1");
  });
});
